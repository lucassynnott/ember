import XCTest
@testable import DriveCore

final class SigV4Tests: XCTestCase {
    /// AWS's published example: "Example: GET Object" from Signature Calculations for the Authorization Header.
    func testAWSDocumentedGetObjectVector() {
        let sig = S3Client.sign(
            method: "GET", path: "/test.txt", query: [],
            headers: ["host": "examplebucket.s3.amazonaws.com", "range": "bytes=0-9",
                      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                      "x-amz-date": "20130524T000000Z"],
            payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            date: Date(timeIntervalSince1970: 1369353600), region: "us-east-1",
            accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        XCTAssertEqual(sig.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")
    }

    /// AWS's published example: "Example: GET Bucket Lifecycle" (query string handling).
    func testAWSDocumentedLifecycleVector() {
        let sig = S3Client.sign(
            method: "GET", path: "/", query: [("lifecycle", "")],
            headers: ["host": "examplebucket.s3.amazonaws.com",
                      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                      "x-amz-date": "20130524T000000Z"],
            payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            date: Date(timeIntervalSince1970: 1369353600), region: "us-east-1",
            accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        XCTAssertEqual(sig.signature, "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543")
    }

    func testEncoding() {
        XCTAssertEqual(S3Client.encode("a b/c+d~é", keepSlash: true), "a%20b/c%2Bd~%C3%A9")
        XCTAssertEqual(S3Client.encode("a/b"), "a%2Fb")
    }

    func testConflictKey() {
        let k = UploadQueue.conflictKey(for: "dir/report.pdf")
        XCTAssertTrue(k.hasPrefix("dir/report (conflicted copy from "))
        XCTAssertTrue(k.hasSuffix(").pdf"))
    }
}
