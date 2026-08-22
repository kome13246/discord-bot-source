function normalizeChannelIds(values) {
  return [...new Set(
    values
      .filter((channelId) => typeof channelId === "string")
      .map((channelId) => channelId.trim())
      .filter(Boolean),
  )];
}

/**
 * Return every configured VC-gathering parent channel.
 *
 * The array field is canonical, while the singular field remains as a
 * compatibility fallback for settings saved by older bot versions.
 */
export function getVoiceReminderParentChannelIds(settings = {}) {
  const configured = normalizeChannelIds(
    Array.isArray(settings?.voiceReminderParentChannelIds)
      ? settings.voiceReminderParentChannelIds
      : [],
  );
  if (configured.length > 0) return configured;
  return normalizeChannelIds([settings?.voiceReminderParentChannelId]);
}

export function formatVoiceReminderParentChannelMentions(settings = {}) {
  const channelIds = getVoiceReminderParentChannelIds(settings);
  return channelIds.length > 0
    ? channelIds.map((channelId) => `<#${channelId}>`).join(" ")
    : "未設定";
}
