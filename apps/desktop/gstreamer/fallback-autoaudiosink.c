/* Compile with -DPACKAGE=\"fallbackautoaudio\".
   WebKit starts the audio device through an element named autoaudiosink.
   That element ships in gst-plugins-good. This fallback is used when that
   package is absent and PipeWire or ALSA is already available. */
#include <gst/gst.h>

#define GST_TYPE_FALLBACK_AUTO_AUDIO_SINK (gst_fallback_auto_audio_sink_get_type())
G_DECLARE_FINAL_TYPE(GstFallbackAutoAudioSink, gst_fallback_auto_audio_sink, GST, FALLBACK_AUTO_AUDIO_SINK, GstBin)

struct _GstFallbackAutoAudioSink {
  GstBin parent;
};

G_DEFINE_TYPE(GstFallbackAutoAudioSink, gst_fallback_auto_audio_sink, GST_TYPE_BIN)

static GstStaticPadTemplate sink_template = GST_STATIC_PAD_TEMPLATE(
    "sink",
    GST_PAD_SINK,
    GST_PAD_ALWAYS,
    GST_STATIC_CAPS("audio/x-raw"));

static void gst_fallback_auto_audio_sink_init(GstFallbackAutoAudioSink *self) {
  GstElement *child = gst_element_factory_make("pipewiresink", "internal-sink");
  if (!child)
    child = gst_element_factory_make("alsasink", "internal-sink");
  if (!child)
    return;

  gst_bin_add(GST_BIN(self), child);
  GstPad *target = gst_element_get_static_pad(child, "sink");
  GstPad *ghost = gst_ghost_pad_new("sink", target);
  gst_object_unref(target);
  if (!ghost)
    return;
  gst_pad_set_active(ghost, TRUE);
  gst_element_add_pad(GST_ELEMENT(self), ghost);
}

static void gst_fallback_auto_audio_sink_class_init(GstFallbackAutoAudioSinkClass *klass) {
  GstElementClass *element_class = GST_ELEMENT_CLASS(klass);
  gst_element_class_set_static_metadata(
      element_class,
      "Fallback auto audio sink",
      "Sink/Audio",
      "Sends audio to PipeWire or ALSA when autoaudiosink is not installed",
      "Audiosous");
  gst_element_class_add_static_pad_template(element_class, &sink_template);
}

static gboolean plugin_init(GstPlugin *plugin) {
  GstPluginFeature *existing = gst_registry_lookup_feature(gst_registry_get(), "autoaudiosink");
  if (existing) {
    GstPlugin *owner = gst_plugin_feature_get_plugin(existing);
    const gchar *name = owner ? gst_plugin_get_name(owner) : NULL;
    gboolean ours = name && g_strcmp0(name, "fallbackautoaudio") == 0;
    if (owner)
      gst_object_unref(owner);
    gst_object_unref(existing);
    if (!ours)
      return TRUE;
  }
  return gst_element_register(plugin, "autoaudiosink", GST_RANK_NONE, GST_TYPE_FALLBACK_AUTO_AUDIO_SINK);
}

GST_PLUGIN_DEFINE(
    GST_VERSION_MAJOR,
    GST_VERSION_MINOR,
    fallbackautoaudio,
    "PipeWire or ALSA fallback for autoaudiosink",
    plugin_init,
    "1.0",
    "LGPL",
    "Audiosous",
    "https://audiosous.local")
