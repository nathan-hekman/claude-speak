// personal-voice-authorize.swift
//
// One-time macOS Personal Voice authorizer for claude-speak.
//
// Apple gates Personal Voice (a synthesized clone of YOUR voice, created in
// System Settings > Accessibility > Personal Voice) behind a per-app
// authorization. The `say` command can only use it once the app that *runs*
// `say` has been granted access. macOS attaches that grant to the "responsible"
// app of the calling process — so this tool must be launched as a child of the
// app that will later run claude-speak's `say` (e.g. the Claude app, or your
// terminal). Run it from there and approve the one-time system dialog.
//
//   swiftc -O personal-voice-authorize.swift -o pv-authorize && ./pv-authorize
//
// Output (parsed by control.sh):
//   AUTH_STATUS=<n> (<symbol>)        3 = authorized
//   PERSONAL_VOICE name=<name> id=<id> lang=<lang>   (one per personal voice)
//
// No private API, no entitlement, no code injection — just the public
// AVSpeechSynthesizer.requestPersonalVoiceAuthorization API.

import AVFoundation
import Foundation

AVSpeechSynthesizer.requestPersonalVoiceAuthorization { status in
    print("AUTH_STATUS=\(status.rawValue) (\(status))")
    if status == .authorized {
        for v in AVSpeechSynthesisVoice.speechVoices()
            where v.voiceTraits.contains(.isPersonalVoice) {
            print("PERSONAL_VOICE name=\(v.name) id=\(v.identifier) lang=\(v.language)")
        }
    }
    exit(0)
}
RunLoop.main.run()
