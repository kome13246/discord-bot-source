export function toCurrentGroupMemberIds(currentGroupMembers, channelId, childChannel) {
  const stored = currentGroupMembers?.get(channelId);
  if (stored) return [...stored];
  return [...(childChannel?.members?.values?.() ?? [])]
    .filter((member) => !member.user?.bot)
    .map((member) => member.id);
}
