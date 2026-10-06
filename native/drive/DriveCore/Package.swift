// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DriveCore",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "DriveCore", targets: ["DriveCore"]),
        .executable(name: "drivectl", targets: ["drivectl"]),
    ],
    targets: [
        .target(name: "DriveCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "drivectl", dependencies: ["DriveCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "DriveCoreTests", dependencies: ["DriveCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
