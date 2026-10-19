// Remote Assist input agent for macOS.
//
// Reads one JSON command per line on stdin and turns it into mouse and keyboard events with
// Quartz Event Services. The host app validates every command before sending it, and keeps the
// agent running while it runs. When stdin closes (the app quit or crashed), the agent lets go of
// every held key and button before exiting, so nothing stays stuck.
//
// Posting events needs the Accessibility permission, which macOS grants to the app that started
// the agent (in development: the terminal). `--dry-run` prints the events instead of posting
// them, which needs no permission and is what the tests use.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

struct Command: Decodable {
    let op: String
    var x: Double?
    var y: Double?
    var button: String?
    var down: Bool?
    var dx: Double?
    var dy: Double?
    var id: String?
    var keycode: UInt16?
    var char: String?
    var isRepeat: Bool?
    var text: String?

    enum CodingKeys: String, CodingKey {
        case op, x, y, button, down, dx, dy, id, keycode, char, text
        case isRepeat = "repeat"
    }
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return }
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

final class Injector {
    private static let modifierMasks: [CGKeyCode: CGEventFlags] = [
        CGKeyCode(kVK_Command): .maskCommand, CGKeyCode(kVK_RightCommand): .maskCommand,
        CGKeyCode(kVK_Shift): .maskShift, CGKeyCode(kVK_RightShift): .maskShift,
        CGKeyCode(kVK_Option): .maskAlternate, CGKeyCode(kVK_RightOption): .maskAlternate,
        CGKeyCode(kVK_Control): .maskControl, CGKeyCode(kVK_RightControl): .maskControl,
        CGKeyCode(kVK_Function): .maskSecondaryFn,
    ]

    private let dryRun: Bool
    private let source: CGEventSource?
    private var position = CGPoint.zero
    private var heldButtons = Set<String>()
    private var heldKeys: [String: CGKeyCode] = [:]
    private var lastClick: (button: String, time: TimeInterval, point: CGPoint, count: Int64)?
    private var layoutID: String?
    private var layoutKeys: [String: CGKeyCode] = [:]

    init(dryRun: Bool) {
        self.dryRun = dryRun
        source = CGEventSource(stateID: .hidSystemState)
        // Grandma's own mouse and keyboard keep working while helper events are posted.
        source?.localEventsSuppressionInterval = 0
        // Tags every event as coming from Remote Assist ("RA").
        source?.userData = 0x5241
    }

    func run(_ command: Command) {
        switch command.op {
        case "move":
            guard let point = point(command) else { return fail(command) }
            move(to: point)
        case "button":
            guard let point = point(command), let name = command.button, let down = command.down
            else { return fail(command) }
            button(name, down: down, at: point)
        case "scroll":
            guard let point = point(command), let dx = command.dx, let dy = command.dy
            else { return fail(command) }
            scroll(dx: dx, dy: dy, at: point)
        case "key":
            guard let id = command.id, let down = command.down, let keycode = command.keycode
            else { return fail(command) }
            key(id: id, down: down, keycode: keycode, char: command.char, isRepeat: command.isRepeat ?? false)
        case "text":
            guard let text = command.text else { return fail(command) }
            type(text)
        case "release":
            releaseAll()
        case "status":
            emit(["event": "status", "trusted": AXIsProcessTrusted()])
        default:
            fail(command)
        }
    }

    // MARK: Mouse

    func move(to point: CGPoint) {
        position = point
        let (type, button): (CGEventType, CGMouseButton)
        // While a button is held, moves must be drags or nothing gets dragged.
        if heldButtons.contains("left") {
            (type, button) = (.leftMouseDragged, .left)
        } else if heldButtons.contains("right") {
            (type, button) = (.rightMouseDragged, .right)
        } else if heldButtons.contains("middle") {
            (type, button) = (.otherMouseDragged, .center)
        } else {
            (type, button) = (.mouseMoved, .left)
        }
        postMouse(type, at: point, button: button, clickState: 0)
    }

    func button(_ name: String, down: Bool, at point: CGPoint) {
        guard let (downType, upType, button) = Self.buttonTypes(name) else { return }
        if point != position { move(to: point) }
        if down {
            guard heldButtons.insert(name).inserted else { return }
            postMouse(downType, at: point, button: button, clickState: clickCount(name, at: point))
        } else {
            guard heldButtons.remove(name) != nil else { return }
            postMouse(upType, at: point, button: button, clickState: lastClick?.count ?? 1)
        }
    }

    /// Synthetic events carry no click count, so double-clicks are counted here.
    private func clickCount(_ name: String, at point: CGPoint) -> Int64 {
        let now = ProcessInfo.processInfo.systemUptime
        var count: Int64 = 1
        if let last = lastClick, last.button == name,
           now - last.time <= NSEvent.doubleClickInterval,
           hypot(point.x - last.point.x, point.y - last.point.y) <= 4 {
            count = last.count + 1
        }
        lastClick = (name, now, point, count)
        return count
    }

    func scroll(dx: Double, dy: Double, at point: CGPoint) {
        if point != position { move(to: point) }
        // DOM wheel deltas: positive dy scrolls content down. Quartz: positive scrolls content up.
        let wheel1 = Int32(clamping: Int(-dy.rounded()))
        let wheel2 = Int32(clamping: Int(-dx.rounded()))
        guard let event = CGEvent(
            scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
            wheel1: wheel1, wheel2: wheel2, wheel3: 0)
        else { return }
        event.flags = modifierFlags()
        post(event, ["x": point.x, "y": point.y, "wheel1": wheel1, "wheel2": wheel2])
    }

    private func postMouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int64) {
        guard let event = CGEvent(
            mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
        else { return }
        if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
        event.flags = modifierFlags()
        post(event, ["x": point.x, "y": point.y, "clickState": clickState])
    }

    private static func buttonTypes(_ name: String) -> (CGEventType, CGEventType, CGMouseButton)? {
        switch name {
        case "left": return (.leftMouseDown, .leftMouseUp, .left)
        case "right": return (.rightMouseDown, .rightMouseUp, .right)
        case "middle": return (.otherMouseDown, .otherMouseUp, .center)
        default: return nil
        }
    }

    // MARK: Keyboard

    func key(id: String, down: Bool, keycode: UInt16, char: String?, isRepeat: Bool) {
        let code: CGKeyCode
        if down {
            // A shortcut types the same character as on the helper's keyboard, whatever the layout.
            code = heldKeys[id] ?? char.flatMap(layoutKeyCode) ?? keycode
            heldKeys[id] = code
        } else {
            guard let held = heldKeys.removeValue(forKey: id) else { return }
            code = held
        }
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        else { return }
        if Self.modifierMasks[code] != nil { event.type = .flagsChanged }
        event.flags = modifierFlags()
        if isRepeat && down { event.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        post(event, ["keycode": Int(code)])
    }

    /// Text goes in as characters, one per event pair, with no modifiers: it can't become a shortcut.
    func type(_ text: String) {
        for character in text {
            let units = Array(String(character).utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                else { continue }
                units.withUnsafeBufferPointer { buffer in
                    event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                }
                event.flags = []
                post(event, ["text": String(character)])
            }
        }
    }

    func releaseAll() {
        // Ordinary keys first, then modifiers, so nothing turns into a shortcut on the way out.
        let ids = heldKeys.keys.sorted { a, b in
            (Self.modifierMasks[heldKeys[a]!] == nil ? 0 : 1) < (Self.modifierMasks[heldKeys[b]!] == nil ? 0 : 1)
        }
        for id in ids { key(id: id, down: false, keycode: 0, char: nil, isRepeat: false) }
        for name in heldButtons.sorted() { button(name, down: false, at: position) }
        lastClick = nil
    }

    private func modifierFlags() -> CGEventFlags {
        heldKeys.values.reduce(into: CGEventFlags()) { flags, code in
            if let mask = Self.modifierMasks[code] { flags.insert(mask) }
        }
    }

    private func layoutKeyCode(for char: String) -> CGKeyCode? {
        refreshLayout()
        return layoutKeys[char.lowercased()]
    }

    /// Maps each character to the key that types it on the current layout (rebuilt when it changes).
    private func refreshLayout() {
        guard let input = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return }
        let id = TISGetInputSourceProperty(input, kTISPropertyInputSourceID)
            .map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String }
        if id == layoutID { return }
        layoutID = id
        layoutKeys = [:]
        guard let pointer = TISGetInputSourceProperty(input, kTISPropertyUnicodeKeyLayoutData) else { return }
        let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
        data.withUnsafeBytes { raw in
            guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            for code in 0..<128 {
                var deadKeyState: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(
                    layout, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeyState, chars.count, &length, &chars)
                guard status == noErr, length > 0 else { continue }
                let character = String(utf16CodeUnits: chars, count: length).lowercased()
                if layoutKeys[character] == nil { layoutKeys[character] = CGKeyCode(code) }
            }
        }
    }

    // MARK: Output

    private func post(_ event: CGEvent, _ details: [String: Any]) {
        guard dryRun else { return event.post(tap: .cghidEventTap) }
        var description = details
        description["event"] = "posted"
        description["type"] = Self.name(of: event.type)
        description["flags"] = event.flags.rawValue
        emit(description)
    }

    private func point(_ command: Command) -> CGPoint? {
        guard let x = command.x, let y = command.y, x.isFinite, y.isFinite else { return nil }
        return CGPoint(x: x, y: y)
    }

    private func fail(_ command: Command) {
        emit(["event": "error", "message": "incomplete \(command.op) command"])
    }

    private static func name(of type: CGEventType) -> String {
        switch type {
        case .mouseMoved: return "mouseMoved"
        case .leftMouseDown: return "leftMouseDown"
        case .leftMouseUp: return "leftMouseUp"
        case .leftMouseDragged: return "leftMouseDragged"
        case .rightMouseDown: return "rightMouseDown"
        case .rightMouseUp: return "rightMouseUp"
        case .rightMouseDragged: return "rightMouseDragged"
        case .otherMouseDown: return "otherMouseDown"
        case .otherMouseUp: return "otherMouseUp"
        case .otherMouseDragged: return "otherMouseDragged"
        case .scrollWheel: return "scrollWheel"
        case .keyDown: return "keyDown"
        case .keyUp: return "keyUp"
        case .flagsChanged: return "flagsChanged"
        default: return "other(\(type.rawValue))"
        }
    }
}

let dryRun = CommandLine.arguments.contains("--dry-run")
let injector = Injector(dryRun: dryRun)
let decoder = JSONDecoder()
emit(["event": "ready", "trusted": AXIsProcessTrusted(), "dryRun": dryRun])

while let line = readLine(strippingNewline: true) {
    guard !line.isEmpty else { continue }
    guard let command = try? decoder.decode(Command.self, from: Data(line.utf8)) else {
        emit(["event": "error", "message": "unreadable command"])
        continue
    }
    injector.run(command)
}
injector.releaseAll()
