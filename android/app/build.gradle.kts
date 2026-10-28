plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.ltanedo.youtubetv"
    compileSdk = 35
    ndkVersion = "28.0.13004108"
    defaultConfig {
        applicationId = "io.github.ltanedo.youtubetv"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += (findProperty("androidAbis") as String? ?: "arm64-v8a,armeabi-v7a,x86_64").split(",") }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/sharedAssets"))
    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("generated/jniLibs"))
}

val sharedAssets by tasks.registering(Sync::class) {
    into(layout.buildDirectory.dir("generated/sharedAssets"))
    from("../../native") { include("tv-navigator.js", "tv-player.js", "THIRD-PARTY-NOTICES.md", "licenses/**") }
    from("../../inject") { include("yttv.css") }
}
val nativeBlocker by tasks.registering(Exec::class) {
    workingDir(rootDir)
    commandLine("bash", "build-native.sh", findProperty("androidAbis") as String? ?: "arm64-v8a,armeabi-v7a,x86_64")
    inputs.files(fileTree("../../native/core") { include("src/**", "data/**", "Cargo.toml") }).withPropertyName("core")
    inputs.dir("../blocker/src")
    inputs.file("../blocker/Cargo.toml")
    inputs.file("../blocker/Cargo.lock")
    inputs.file("../build-native.sh")
    inputs.property("abis", findProperty("androidAbis") ?: "arm64-v8a,armeabi-v7a,x86_64")
    outputs.dir(layout.buildDirectory.dir("generated/jniLibs"))
}
tasks.named("preBuild") { dependsOn(sharedAssets, nativeBlocker) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:core:1.6.1")
}
