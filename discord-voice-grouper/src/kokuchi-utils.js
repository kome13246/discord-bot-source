const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function getJstScheduledTime(date, hour, minute) {
  const timestamp = date instanceof Date ? date.getTime() : Number.NaN;

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const jstDate = new Date(timestamp + JST_OFFSET_MS);
  return new Date(Date.UTC(
    jstDate.getUTCFullYear(),
    jstDate.getUTCMonth(),
    jstDate.getUTCDate(),
    hour - 9,
    minute,
    0,
    0,
  ));
}

export async function editEveryoneConnectPermission({
  channel,
  guildId,
  canConnect,
  reason,
}) {
  const updatedChannel = await channel.permissionOverwrites.edit(
    guildId,
    { Connect: canConnect },
    { reason },
  );

  return Boolean(updatedChannel);
}

export function resolveKokuchiGatheringVoiceChannelId(
  initialSettings,
  nextSettings,
) {
  return (
    initialSettings?.gatheringVoiceChannelId ??
    nextSettings?.gatheringVoiceChannelId ??
    null
  );
}

/**
 * Returns whether regularly scheduled call-wait prompts are paused for a
 * /kokuchi day. The comparison is intentionally based on JST, not the
 * server's local timezone.
 */
export function isKokuchiCallWaitPause(settings, now) {
  const timestamp = now instanceof Date ? now.getTime() : Number.NaN;
  const kokuchiPostedAt = new Date(settings?.lastKokuchiPostedAt);

  if (!Number.isFinite(timestamp) || !Number.isFinite(kokuchiPostedAt.getTime())) {
    return false;
  }

  const jstDate = new Date(timestamp + JST_OFFSET_MS);
  const jstHour = jstDate.getUTCHours();

  return (
    jstHour >= 20 &&
    jstHour < 22 &&
    isSameJstDate(kokuchiPostedAt, now)
  );
}

function isSameJstDate(left, right) {
  const leftJst = new Date(left.getTime() + JST_OFFSET_MS);
  const rightJst = new Date(right.getTime() + JST_OFFSET_MS);

  return (
    leftJst.getUTCFullYear() === rightJst.getUTCFullYear() &&
    leftJst.getUTCMonth() === rightJst.getUTCMonth() &&
    leftJst.getUTCDate() === rightJst.getUTCDate()
  );
}

export function formatSplitClosingThanks({
  feedbackChannelId,
  nextWeekday,
  participantCount,
}) {
  return [
    "ご参加いただきありがとうございました！！",
    `今回の参加人数は${participantCount}人でした！`,
    "",
    "やってみての意見や苦情等があれば",
    ` <#${feedbackChannelId}> からお願いします！`,
    "",
    `次回(${nextWeekday})もぜひご参加ください！`,
  ].join("\n");
}

export function countUniqueParticipantIds(participantMemberIds) {
  return new Set(participantMemberIds).size;
}
