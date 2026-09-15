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

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
