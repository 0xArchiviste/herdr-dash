//go:build desktop && linux

package main

// WebKitGTK turns media streams off by default and Wails v2 answers no
// permission requests, so getUserMedia would fail. This finds the window's
// web view, enables media streams, and grants microphone (audio only)
// requests from the dashboard's own origin; everything else stays denied.

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.1
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>

static char *herdr_origin = NULL;
static volatile int herdr_mic_done = 0;

static gboolean herdr_permission(WebKitWebView *wv, WebKitPermissionRequest *req, gpointer data) {
	if (WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(req)) {
		WebKitUserMediaPermissionRequest *m = WEBKIT_USER_MEDIA_PERMISSION_REQUEST(req);
		const char *uri = webkit_web_view_get_uri(wv);
		if (webkit_user_media_permission_is_for_audio_device(m) &&
		    !webkit_user_media_permission_is_for_video_device(m) &&
		    herdr_origin && uri && g_str_has_prefix(uri, herdr_origin)) {
			webkit_permission_request_allow(req);
			return TRUE;
		}
	}
	webkit_permission_request_deny(req);
	return TRUE;
}

static void herdr_hook(GtkWidget *w) {
	if (WEBKIT_IS_WEB_VIEW(w)) {
		if (!g_object_get_data(G_OBJECT(w), "herdr-mic")) {
			WebKitSettings *s = webkit_web_view_get_settings(WEBKIT_WEB_VIEW(w));
			webkit_settings_set_enable_media_stream(s, TRUE);
			g_signal_connect(w, "permission-request", G_CALLBACK(herdr_permission), NULL);
			g_object_set_data(G_OBJECT(w), "herdr-mic", GINT_TO_POINTER(1));
		}
		return;
	}
	if (GTK_IS_CONTAINER(w)) {
		GList *kids = gtk_container_get_children(GTK_CONTAINER(w));
		for (GList *k = kids; k; k = k->next) herdr_hook(GTK_WIDGET(k->data));
		g_list_free(kids);
	}
}

static gboolean herdr_hook_all(gpointer origin) {
	g_free(herdr_origin);
	herdr_origin = origin;
	GList *tops = gtk_window_list_toplevels();
	for (GList *t = tops; t; t = t->next) herdr_hook(GTK_WIDGET(t->data));
	g_list_free(tops);
	herdr_mic_done = 1;
	return G_SOURCE_REMOVE;
}

static void herdr_enable_mic(const char *origin) {
	herdr_mic_done = 0;
	g_idle_add(herdr_hook_all, g_strdup(origin));
}

static int herdr_mic_ready(void) { return herdr_mic_done; }
*/
import "C"

import (
	"os"
	"time"
	"unsafe"
)

// The dashboard is dark; form controls WebKitGTK draws with the GTK theme
// (select boxes) would otherwise come out light.
func init() {
	if os.Getenv("GTK_THEME") == "" {
		os.Setenv("GTK_THEME", "Adwaita:dark")
	}
}

// enableMic runs on the GTK main loop and returns once it did, before the
// window navigates to origin.
func enableMic(origin string) {
	cs := C.CString(origin)
	defer C.free(unsafe.Pointer(cs))
	C.herdr_enable_mic(cs)
	for end := time.Now().Add(3 * time.Second); C.herdr_mic_ready() == 0 && time.Now().Before(end); {
		time.Sleep(10 * time.Millisecond)
	}
}

func startWSLService() error { return errNotWindows }
