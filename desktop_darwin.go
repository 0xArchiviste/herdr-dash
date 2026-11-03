//go:build desktop && darwin

package main

// WKWebView asks the user once for the microphone; the app bundle's
// Info.plist carries NSMicrophoneUsageDescription (make desktop-darwin).
func enableMic(string) {}

func startWSLService() error { return errNotWindows }
