export function getGroupSizes(total) {
  if (total === 0) {
    return [];
  }

  if (total < 3) {
    return [total];
  }

  if (total === 5) {
    return [3, 2];
  }

  const groupCount = Math.floor(total / 3);
  const extraCount = total % 3;

  return Array.from({ length: groupCount }, (_, index) =>
    index < extraCount ? 4 : 3,
  );
}

export function shuffle(items) {
  const copied = [...items];

  for (let index = copied.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copied[index], copied[randomIndex]] = [copied[randomIndex], copied[index]];
  }

  return copied;
}

export function buildGroups(items) {
  const sizes = getGroupSizes(items.length);
  const groups = [];
  let cursor = 0;

  for (const size of sizes) {
    groups.push(items.slice(cursor, cursor + size));
    cursor += size;
  }

  return groups;
}

export function describeGroups(total, groups) {
  if (total === 0) {
    return "対象メンバーがいません。";
  }

  if (total < 3) {
    return "3人未満のため、小さなグループとして表示します。";
  }

  if (total === 5) {
    return "5人は3人・4人だけでは分けきれないため、3人と2人のグループとして表示します。";
  }

  const threeCount = groups.filter((group) => group.length === 3).length;
  const fourCount = groups.filter((group) => group.length === 4).length;
  const overThirty = total > 30 ? " 30人を超えていますが、そのまま処理しました。" : "";

  return `${total}人を${groups.length}グループに分けました。3人グループ: ${threeCount}、4人グループ: ${fourCount}。${overThirty}`;
}
