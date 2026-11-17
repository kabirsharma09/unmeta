// Writes genuine Apple-encoded test files (ImageIO / AVFoundation) carrying known private details.
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let out = URL(fileURLWithPath: CommandLine.arguments[1])

func picture(_ w: Int, _ h: Int, hue: CGFloat) -> CGImage {
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let grad = CGGradient(colorsSpace: cs, colors: [CGColor(red: 0.23, green: 0.21, blue: 0.47, alpha: 1),
                                                    CGColor(red: 0.85, green: 0.35 + hue * 0.1, blue: 0.48, alpha: 1),
                                                    CGColor(red: 1, green: 0.82, blue: 0.48, alpha: 1)] as CFArray,
                        locations: [0, 0.55, 1])!
  ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: h), end: CGPoint(x: 0, y: 0), options: [])
  ctx.setFillColor(CGColor(red: 1, green: 0.95, blue: 0.77, alpha: 1))
  ctx.fillEllipse(in: CGRect(x: w * 6 / 10, y: h * 3 / 10, width: w / 6, height: w / 6))
  ctx.setFillColor(CGColor(red: 0.16, green: 0.36, blue: 0.55, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h * 3 / 10))
  return ctx.makeImage()!
}

let props: [CFString: Any] = [
  kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 51.5072, kCGImagePropertyGPSLatitudeRef: "N",
                                  kCGImagePropertyGPSLongitude: 0.1275, kCGImagePropertyGPSLongitudeRef: "W",
                                  kCGImagePropertyGPSAltitude: 11.2, kCGImagePropertyGPSAltitudeRef: 0],
  kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "Apple", kCGImagePropertyTIFFModel: "iPhone 15 Pro",
                                   kCGImagePropertyTIFFSoftware: "17.2", kCGImagePropertyTIFFArtist: "Jane Doe",
                                   kCGImagePropertyTIFFDateTime: "2026:03:01 09:15:42"],
  kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2026:03:01 09:15:42",
                                   kCGImagePropertyExifOffsetTimeOriginal: "+01:00",
                                   kCGImagePropertyExifBodySerialNumber: "C39XK1234ABC",
                                   kCGImagePropertyExifLensModel: "iPhone 15 Pro back triple camera 6.765mm f/1.78",
                                   kCGImagePropertyExifCameraOwnerName: "Jane Doe"],
  kCGImageDestinationEmbedThumbnail: true,
  kCGImageDestinationLossyCompressionQuality: 0.8,
]

for (name, type) in [("apple.heic", UTType.heic), ("apple.jpg", UTType.jpeg)] {
  let url = out.appendingPathComponent(name)
  let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, picture(2048, 1536, hue: 0), props as CFDictionary)
  precondition(CGImageDestinationFinalize(dest), "could not write \(name)")
}

// ---- video: 1 second of H.264 with Apple's QuickTime metadata keys
func video(_ name: String, _ type: AVFileType) async throws {
  let url = out.appendingPathComponent(name)
  try? FileManager.default.removeItem(at: url)
  let w = try AVAssetWriter(outputURL: url, fileType: type)
  func item(_ id: AVMetadataIdentifier, _ v: String) -> AVMetadataItem {
    let m = AVMutableMetadataItem(); m.identifier = id; m.value = v as NSString; m.dataType = kCMMetadataBaseDataType_UTF8 as String; return m
  }
  w.metadata = [item(.quickTimeMetadataLocationISO6709, "+51.5072-000.1275+011.200/"),
                item(.quickTimeMetadataMake, "Apple"), item(.quickTimeMetadataModel, "iPhone 15 Pro"),
                item(.quickTimeMetadataSoftware, "17.2"), item(.quickTimeMetadataAuthor, "Jane Doe"),
                item(.quickTimeMetadataCreationDate, "2026-03-01T09:15:42+0100")]
  let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                                                                      AVVideoWidthKey: 640, AVVideoHeightKey: 480])
  let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes:
    [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 640,
     kCVPixelBufferHeightKey as String: 480])
  w.add(input)
  w.startWriting(); w.startSession(atSourceTime: .zero)
  for f in 0..<30 {
    while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, ad.pixelBufferPool!, &pb)
    CVPixelBufferLockBaseAddress(pb!, [])
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb!), width: 640, height: 480, bitsPerComponent: 8,
                        bytesPerRow: CVPixelBufferGetBytesPerRow(pb!), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
    ctx.draw(picture(640, 480, hue: CGFloat(f) / 30), in: CGRect(x: 0, y: 0, width: 640, height: 480))
    CVPixelBufferUnlockBaseAddress(pb!, [])
    ad.append(pb!, withPresentationTime: CMTime(value: Int64(f), timescale: 30))
  }
  input.markAsFinished()
  await w.finishWriting()
  precondition(w.status == .completed, "video failed: \(String(describing: w.error))")
}
try await video("apple.mov", .mov)
try await video("apple.mp4", .mp4)
print("ok")
