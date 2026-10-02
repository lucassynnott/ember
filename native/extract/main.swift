// Prints the text of a PDF, for the knowledge base. Usage: meeting-notes-extract <file.pdf>
import Foundation
import PDFKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("Usage: meeting-notes-extract <file.pdf>\n".utf8))
    exit(2)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let document = PDFDocument(url: url) else {
    FileHandle.standardError.write(Data("Couldn't open \(url.lastPathComponent).\n".utf8))
    exit(1)
}
var text = ""
for index in 0..<min(document.pageCount, 500) {
    if let page = document.page(at: index)?.string { text += page + "\n\n" }
}
FileHandle.standardOutput.write(Data(text.utf8))
