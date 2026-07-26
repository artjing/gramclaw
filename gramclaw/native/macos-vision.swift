import AppKit
import CoreImage
import Foundation
import Vision

struct VisionResult: Codable {
    let ocrText: String
    let labels: [String]
    let colors: [String]
}

func hex(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> String {
    String(
        format: "#%02X%02X%02X",
        Int(max(0, min(255, red * 255))),
        Int(max(0, min(255, green * 255))),
        Int(max(0, min(255, blue * 255)))
    )
}

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write(Data("Image path required\n".utf8))
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: imageURL),
      let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage else {
    FileHandle.standardError.write(Data("Unable to read image\n".utf8))
    exit(3)
}

let textRequest = VNRecognizeTextRequest()
textRequest.recognitionLevel = .accurate
textRequest.usesLanguageCorrection = true

let classifyRequest = VNClassifyImageRequest()
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([textRequest, classifyRequest])

let text = (textRequest.results ?? [])
    .compactMap { $0.topCandidates(1).first?.string }
    .joined(separator: "\n")

let labels = (classifyRequest.results ?? [])
    .filter { $0.confidence >= 0.08 }
    .prefix(12)
    .map { $0.identifier }

let context = CIContext(options: [.workingColorSpace: NSNull()])
let ciImage = CIImage(cgImage: cgImage)
let extent = ciImage.extent
let inputExtent = CIVector(x: extent.origin.x, y: extent.origin.y, z: extent.size.width, w: extent.size.height)
let filter = CIFilter(name: "CIAreaAverage", parameters: [
    kCIInputImageKey: ciImage,
    kCIInputExtentKey: inputExtent
])

var colors: [String] = []
if let output = filter?.outputImage {
    var rgba = [UInt8](repeating: 0, count: 4)
    context.render(
        output,
        toBitmap: &rgba,
        rowBytes: 4,
        bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
        format: .RGBA8,
        colorSpace: CGColorSpaceCreateDeviceRGB()
    )
    colors.append(String(format: "#%02X%02X%02X", rgba[0], rgba[1], rgba[2]))
}

let result = VisionResult(ocrText: text, labels: labels, colors: colors)
let data = try JSONEncoder().encode(result)
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
