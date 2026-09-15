package org.smsgateway.agent.db

import android.content.Context
import androidx.room.*

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

@Database(entities = [PendingEvent::class], version = 1, exportSchema = false)
abstract class AgentDatabase : RoomDatabase() {
    abstract fun events(): EventDao

    companion object {
        @Volatile private var instance: AgentDatabase? = null

        fun get(ctx: Context): AgentDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                ctx.applicationContext, AgentDatabase::class.java, "agent.db",
            ).build().also { instance = it }
        }
    }
}
