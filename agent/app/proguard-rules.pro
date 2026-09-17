# Cactus 通过反射与多进程启动服务，整体保留
-keep class com.gyf.cactus.** { *; }

# 崩溃堆栈要能还原成源码位置。
#
# 不保留这两个属性的话，release 的异常堆栈连行号都没有——而 Agent 跑在
# 一台放在家里、平时没人看的手机上，崩溃报告就是唯一的线索。
# 还原要用与那次构建**完全对应**的 mapping.txt，所以发布时要把它存下来
# （见 agent/mapping/，以及 CLAUDE.md 的发布步骤）。
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# kotlinx.serialization 生成的序列化器
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class org.smsgateway.agent.protocol.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class org.smsgateway.agent.protocol.**$$serializer { *; }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
