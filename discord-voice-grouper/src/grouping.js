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

export const GROUPING_CANDIDATE_COUNT = 500;

export function createPairKey(userId1, userId2) {
  return [String(userId1), String(userId2)].sort().join(":");
}

export function getPairKeysFromGroups(groups = []) {
  const pairKeys = new Set();

  for (const group of groups) {
    const sourceMembers = Array.isArray(group) ? group : group?.memberIds ?? [];
    const memberIds = [...new Set(
      sourceMembers
        .map((member) => typeof member === "string" ? member : member?.id)
        .filter(Boolean)
        .map(String),
    )];

    for (let left = 0; left < memberIds.length; left += 1) {
      for (let right = left + 1; right < memberIds.length; right += 1) {
        pairKeys.add(createPairKey(memberIds[left], memberIds[right]));
      }
    }
  }

  return pairKeys;
}

export function countRepeatedPairs(groups, previousPairKeys) {
  const previous = previousPairKeys instanceof Set
    ? previousPairKeys
    : new Set(previousPairKeys ?? []);
  let repeatedPairCount = 0;

  for (const pairKey of getPairKeysFromGroups(groups)) {
    if (previous.has(pairKey)) {
      repeatedPairCount += 1;
    }
  }

  return repeatedPairCount;
}

export function chooseGroupsWithHistory(
  members,
  previousGroups = [],
  { candidateCount = GROUPING_CANDIDATE_COUNT } = {},
) {
  const previousPairKeys = getPairKeysFromGroups(previousGroups);

  if (members.length === 0) {
    return { groups: [], score: 0, candidateCount: 0, evaluatedCandidateCount: 0 };
  }

  const evaluated = new Map();
  const attempts = Math.max(1, Number.isInteger(candidateCount) ? candidateCount : GROUPING_CANDIDATE_COUNT);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = buildGroups(shuffle(members));
    const key = candidate
      .map((group) => group.map((member) => member.id).sort().join(","))
      .sort()
      .join("|");

    if (!evaluated.has(key)) {
      evaluated.set(key, {
        groups: candidate,
        score: countRepeatedPairs(candidate, previousPairKeys),
      });
    }
  }

  const candidates = [...evaluated.values()];
  const bestScore = Math.min(...candidates.map((candidate) => candidate.score));
  const bestCandidates = candidates.filter((candidate) => candidate.score === bestScore);
  const selected = bestCandidates[Math.floor(Math.random() * bestCandidates.length)];

  return {
    groups: selected.groups,
    score: selected.score,
    candidateCount: attempts,
    evaluatedCandidateCount: candidates.length,
  };
}

export function chooseBestGroupForMember(memberId, groups, previousPairKeys) {
  const previous = previousPairKeys instanceof Set
    ? previousPairKeys
    : new Set(previousPairKeys ?? []);
  const candidates = groups.map((group, index) => {
    const memberIds = group.memberIds ?? group.members ?? [];
    const repeatedPairCount = memberIds.reduce(
      (count, existingMemberId) => count + (previous.has(createPairKey(memberId, existingMemberId)) ? 1 : 0),
      0,
    );
    return {
      ...group,
      index,
      repeatedPairCount,
      memberCount: memberIds.length,
    };
  });

  if (candidates.length === 0) {
    return null;
  }

  const bestScore = Math.min(...candidates.map((candidate) => candidate.repeatedPairCount));
  const bestCount = Math.min(
    ...candidates
      .filter((candidate) => candidate.repeatedPairCount === bestScore)
      .map((candidate) => candidate.memberCount),
  );
  const tied = candidates.filter(
    (candidate) => candidate.repeatedPairCount === bestScore && candidate.memberCount === bestCount,
  );

  return tied[Math.floor(Math.random() * tied.length)];
}

export function chooseBestMemberSubset(members, size, previousPairKeys, candidateCount = 100) {
  if (members.length <= size) {
    return [...members];
  }

  const candidates = new Map();
  for (let attempt = 0; attempt < candidateCount; attempt += 1) {
    const candidate = shuffle(members).slice(0, size);
    const key = candidate.map((member) => member.id).sort().join(",");
    if (!candidates.has(key)) {
      candidates.set(key, {
        members: candidate,
        score: countRepeatedPairs([candidate], previousPairKeys),
      });
    }
  }

  const bestScore = Math.min(...[...candidates.values()].map((candidate) => candidate.score));
  const best = [...candidates.values()].filter((candidate) => candidate.score === bestScore);
  return best[Math.floor(Math.random() * best.length)].members;
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
  const underSix =
    total < 6
      ? " 推奨人数は6人以上ですが、このまま転送プロセスを続行します。"
      : "";

  return `${total}人を${groups.length}グループに分けました。3人グループ: ${threeCount}、4人グループ: ${fourCount}。${underSix}`;
}
