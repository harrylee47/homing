package org.smsgateway.agent.db

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration

/**
 * 离线事件队列。
 *
 * 断网期间事件写这里，重连后按 occurredAt 升序补传，收到 event_ack 才删除。
 * 这是整套系统存在的理由——断网期间的验证码不能丢（计划 §10.2）。
 */
@Entity(tableName = "pending_events")
data class PendingEvent(
    /** 设备端生成的 evt_<uuid>，同时是服务端幂等键 */
    @PrimaryKey val id: String,
    val kind: String,
    val from: String,
    val content: String,
    /** 事件真实发生时间 */
    val occurredAt: Long,
    val simSlot: Int?,
    val callType: String?,
    val pkg: String?,
    val truncated: Boolean,
    /** in=收到，out=这台设备发出的。默认 in，兼容升级前入队的旧记录 */
    val direction: String = "in",
    /** 历史导入的记录。服务端见到它只归档不推送 */
    val imported: Boolean = false,
    /** 入队时间，仅用于排查 */
    val queuedAt: Long,
)

@Dao
interface EventDao {
    /** 同 id 重复插入直接忽略——本地也要幂等，避免同一条短信被多个广播触发两次。 */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(e: PendingEvent): Long

    /** 补传按 occurredAt 升序，保证接收端顺序与真实发生顺序一致。 */
    @Query("SELECT * FROM pending_events ORDER BY occurredAt ASC LIMIT :limit")
    suspend fun oldest(limit: Int): List<PendingEvent>

    @Query("DELETE FROM pending_events WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("SELECT COUNT(*) FROM pending_events")
    suspend fun count(): Int

    /** 超出上限时丢弃最旧的若干条，并由调用方告警。 */
    @Query("DELETE FROM pending_events WHERE id IN (SELECT id FROM pending_events ORDER BY occurredAt ASC LIMIT :n)")
    suspend fun dropOldest(n: Int)
}

@Database(entities = [PendingEvent::class], version = 3, exportSchema = false)
abstract class AgentDatabase : RoomDatabase() {
    abstract fun events(): EventDao

    companion object {
        @Volatile private var instance: AgentDatabase? = null

        /**
         * 加 direction 列的迁移。
         *
         * 不用 fallbackToDestructiveMigration：那会在升级时清空队列，
         * 而队列里可能正躺着断网期间收到的验证码。
         */
        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE pending_events ADD COLUMN direction TEXT NOT NULL DEFAULT 'in'")
            }
        }

        /** 加 imported 列的迁移。历史导入的记录只归档不推送，这个标记要跟着事件走。 */
        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE pending_events ADD COLUMN imported INTEGER NOT NULL DEFAULT 0")
            }
        }

        fun get(ctx: Context): AgentDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                ctx.applicationContext, AgentDatabase::class.java, "agent.db",
            ).addMigrations(MIGRATION_1_2, MIGRATION_2_3).build().also { instance = it }
        }
    }
}
