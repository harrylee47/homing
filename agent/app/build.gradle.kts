plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

android {
    namespace = "org.smsgateway.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.smsgateway.agent"
        minSdk = 24
        // 目标机是 Android 12 (SDK 31)。停在 33 是有意的：
        // targetSdk 34 起前台服务必须声明 foregroundServiceType，
        // 而 Cactus 的 AAR 停更在 targetSdk 29，不带该声明。
        targetSdk = 33
        versionCode = 1
        versionName = "0.1.0"
    }

    /**
     * 发布签名。
     *
     * 密钥**不在仓库里**：从环境变量或 ~/.gradle/gradle.properties 读。
     * 没配的话 release 构建会退回调试签名——能装能跑，但换机器构建出的包
     * 签名不同，无法覆盖安装。正式发版必须配好。
     */
    signingConfigs {
        create("release") {
            val storePath = (project.findProperty("HOMING_KEYSTORE") as String?)
                ?: System.getenv("HOMING_KEYSTORE")
            if (storePath != null && file(storePath).exists()) {
                storeFile = file(storePath)
                storePassword = (project.findProperty("HOMING_KEYSTORE_PASSWORD") as String?)
                    ?: System.getenv("HOMING_KEYSTORE_PASSWORD")
                keyAlias = (project.findProperty("HOMING_KEY_ALIAS") as String?)
                    ?: System.getenv("HOMING_KEY_ALIAS") ?: "smsgateway"
                keyPassword = (project.findProperty("HOMING_KEY_PASSWORD") as String?)
                    ?: System.getenv("HOMING_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            /**
             * 没有发布密钥时**用 debug 签名，但要标记出来**。
             *
             * 这里曾经是静默回落：密钥文件不在（换了台机器、或者丢了），
             * assembleRelease 照样 BUILD SUCCESSFUL，产出一个用 debug key 签的包。
             * 把它当成正式包发出去，后果是**所有现有用户都无法覆盖安装**——
             * 只能卸载重装，而卸载意味着丢掉配对，得跑到手机跟前重新扫码。
             *
             * 构建不失败（本地调试 release 行为时确实需要），但会打一条醒目的警告，
             * 并且 verifyReleaseSigning 任务会直接失败——发布前跑它。
             */
            val rel = signingConfigs.getByName("release")
            signingConfig = if (rel.storeFile != null) rel else {
                logger.warn(
                    "\n========================================\n" +
                    "警告：没有找到发布密钥，这个 release 包用的是 DEBUG 签名。\n" +
                    "它无法覆盖安装已经发布的版本——用户只能卸载重装并重新配对。\n" +
                    "**不要把它放进 web/download/**。\n" +
                    "密钥位置见 CLAUDE.md：~/.smsgateway-release.properties\n" +
                    "========================================\n",
                )
                signingConfigs.getByName("debug")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/AL2.0", "META-INF/LGPL2.1")
    }
}

dependencies {
    // 保活：Cactus。jcenter 已停服，AAR 随仓库分发以保证构建可复现。
    // 来源 https://maven.aliyun.com/repository/jcenter/com/gyf/cactus/cactus/1.1.3-beta13/
    // sha256 df4c1bca2c3d6db65125555e277a712280c489816a25505bee6b480cc6b7537a
    implementation(files("libs/cactus-1.1.3-beta13.aar"))
    // Cactus 自身的传递依赖，见其 POM：kotlin-stdlib / appcompat / work-runtime / gson
    implementation(libs.androidx.work)
    implementation(libs.gson)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.material)

    implementation(libs.okhttp)
    implementation(libs.zxing.embedded)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

/**
 * 发布前跑一下：确认这个 release 包真的是用发布密钥签的。
 *
 * 光看 BUILD SUCCESSFUL 是看不出来的——没有密钥时构建同样成功，
 * 只是签名换成了 debug key，而那样的包覆盖安装不上。
 */
tasks.register("verifyReleaseSigning") {
    group = "verification"
    description = "确认 release 包用的是发布密钥而不是 debug key"
    doLast {
        val rel = android.signingConfigs.getByName("release")
        check(rel.storeFile != null) {
            "没有发布密钥（HOMING_KEYSTORE 未设置或文件不存在），" +
                "构建出来的 release 包用的是 debug 签名，无法覆盖安装已发布的版本。" +
                "密钥位置见 CLAUDE.md。"
        }
    }
}
