# Cactus 通过反射与多进程启动服务，整体保留
-keep class com.gyf.cactus.** { *; }

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
