import AVFoundation
import Foundation
import ImageIO
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
for n in ["apple.heic", "clean_apple.heic", "apple.jpg", "clean_apple.jpg"] {
  let src = CGImageSourceCreateWithURL(dir.appendingPathComponent(n) as CFURL, nil)!
  let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as! [CFString: Any]
  let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
  let tiff = p[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
  let exif = p[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
  print(n, "decodes:", img.map { "\($0.width)x\($0.height)" } ?? "NO",
        "| GPS:", p[kCGImagePropertyGPSDictionary] != nil, "| Make:", tiff[kCGImagePropertyTIFFMake] ?? "-",
        "| Artist:", tiff[kCGImagePropertyTIFFArtist] ?? "-", "| Serial:", exif[kCGImagePropertyExifBodySerialNumber] ?? "-",
        "| Orientation:", p[kCGImagePropertyOrientation] ?? "-", "| ColorModel:", p[kCGImagePropertyColorModel] ?? "-")
}
for n in ["apple.mov", "clean_apple.mov", "apple.mp4", "clean_apple.mp4"] {
  let a = AVURLAsset(url: dir.appendingPathComponent(n))
  let d = try await a.load(.duration)
  var meta: [String] = []
  for f in try await a.load(.availableMetadataFormats) {
    for m in try await a.loadMetadata(for: f) { meta.append("\(m.identifier?.rawValue ?? "?")=\(try await m.load(.stringValue) ?? "")") }
  }
  let gen = AVAssetImageGenerator(asset: a)
  let frame = try? await gen.image(at: CMTime(value: 15, timescale: 30)).image
  print(n, "plays:", String(format: "%.2fs", d.seconds), "| frame:", frame.map { "\($0.width)x\($0.height)" } ?? "NO", "| metadata:", meta.isEmpty ? "none" : meta.joined(separator: ", "))
}
