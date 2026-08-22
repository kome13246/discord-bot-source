import { randomUUID } from "node:crypto";
import {
  ADMIN_CONFIGURATION_KEYS,
  pickConfigurationPatch,
} from "./settings-configuration.js";
import { SETUP_DRAFT_FEATURES } from "./models/setup-draft.js";
import { validateSetupDraft, visibleSetupFields } from "./setup-schema.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function plain(value) {
  if (value && typeof value.toObject === "function") return value.toObject();
  return value ?? null;
}

async function resolveQuery(value) {
  if (value && typeof value.lean === "function") return value.lean();
  return value;
}

function dateValue(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

function revisionOf(settings) {
  const revision = Number(settings?.configRevision ?? settings?.revision ?? 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function boundedError(error, max = 500) {
  return String(error?.message ?? error ?? "unknown error")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function assertFeature(feature) {
  if (feature === null || feature === undefined || SETUP_DRAFT_FEATURES.includes(feature)) return;
  const error = new Error(`Unsupported setup feature: ${feature}`);
  error.code = "SETUP_FEATURE_UNSUPPORTED";
  throw error;
}

function safePatch(patch = {}) {
  const clean = pickConfigurationPatch(patch);
  for (const key of Object.keys(clean)) {
    if (!ADMIN_CONFIGURATION_KEYS.has(key)) {
      const error = new Error(`Setup patch contains a non-catalog key: ${key}`);
      error.code = "SETUP_PATCH_NOT_ALLOWLISTED";
      throw error;
    }
  }
  return clean;
}

function activeFilter({ guildId, actorUserId }) {
  return {
    guildId,
    actorUserId,
    status: "active",
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

export class SetupDraftNotFoundError extends Error {
  constructor() {
    super("The setup draft was not found, expired, or is not owned by this user.");
    this.code = "SETUP_DRAFT_NOT_FOUND";
  }
}

export class SetupDraftConflictError extends Error {
  constructor(message = "The setup draft is already being committed or was changed by another interaction.") {
    super(message);
    this.code = "SETUP_DRAFT_CONFLICT";
  }
}

export class SetupDraftResourceInvalidError extends Error {
  constructor(reason = "A selected Discord resource no longer exists or has changed type.") {
    super(reason);
    this.name = "SetupDraftResourceInvalidError";
    this.code = "SETUP_DRAFT_RESOURCE_INVALID";
  }
}

/**
 * Persistence boundary for setup drafts.  The feature UI never writes
 * GuildSettings directly; only commitDraft calls the supplied versioned
 * configuration writer after an atomic active -> committing claim.
 */
export function createSetupDraftService({
  draftModel,
  configurationService = null,
  getGuildSettings = null,
  getGuild = null,
  validateSetupResources = null,
  saveVersionedGuildConfiguration,
  now = () => new Date(),
  ttlMs = DEFAULT_TTL_MS,
  logger = console,
} = {}) {
  if (!draftModel) throw new Error("draftModel is required.");
  if (typeof saveVersionedGuildConfiguration !== "function") throw new Error("saveVersionedGuildConfiguration is required.");

  async function findOne(filter) {
    if (typeof draftModel.findOne !== "function") return null;
    return plain(await resolveQuery(draftModel.findOne(filter)));
  }

  async function findOneAndUpdate(filter, update, options = {}) {
    if (typeof draftModel.findOneAndUpdate !== "function") return null;
    return plain(await resolveQuery(draftModel.findOneAndUpdate(filter, update, { new: true, returnDocument: "after", ...options })));
  }

  async function expireIfNeeded(draft) {
    if (!draft) return null;
    if (draft.status === "active" && dateValue(draft.expiresAt).getTime() <= dateValue(now()).getTime()) {
      await findOneAndUpdate(
        { sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, status: "active" },
        { $set: { status: "expired", lastError: "Setup draft expired.", updatedAt: dateValue(now()) } },
      );
      return { ...draft, status: "expired" };
    }
    return draft;
  }

  async function getDraft(sessionId, { guildId, actorUserId, includeInactive = false } = {}) {
    if (!sessionId || !guildId || !actorUserId) return null;
    const statusFilter = includeInactive
      ? {}
      : { status: { $in: ["active", "committing"] } };
    const draft = await findOne({ sessionId, guildId, actorUserId, ...statusFilter });
    return expireIfNeeded(draft);
  }

  async function findActiveForActor(guildId, actorUserId) {
    if (!guildId || !actorUserId) return null;
    const draft = await findOne(activeFilter({ guildId, actorUserId }));
    return expireIfNeeded(draft);
  }

  async function findActiveForGuild(guildId) {
    if (!guildId) return null;
    const draft = await findOne({ guildId, status: { $in: ["active", "committing"] } });
    const result = await expireIfNeeded(draft);
    return result?.status === "active" || result?.status === "committing" ? result : null;
  }

  async function currentRevision(guildId) {
    if (configurationService?.getCurrentConfiguration) {
      return revisionOf(await configurationService.getCurrentConfiguration(guildId));
    }
    if (typeof getGuildSettings === "function") return revisionOf(await getGuildSettings(guildId));
    return 0;
  }

  async function startDraft({ guildId, actorUserId } = {}) {
    if (!guildId || !actorUserId) throw new Error("guildId and actorUserId are required.");
    const own = await findActiveForActor(guildId, actorUserId);
    if (own?.status === "active") return { status: "resumed", draft: own };
    const existing = await findActiveForGuild(guildId);
    if (existing) return { status: "busy", draft: existing };

    const draft = {
      sessionId: randomUUID(),
      guildId,
      actorUserId,
      baseRevision: await currentRevision(guildId),
      feature: null,
      step: "feature",
      patch: {},
      status: "active",
      expiresAt: new Date(dateValue(now()).getTime() + Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS)),
      lastError: null,
      committedRevision: null,
    };
    try {
      const created = typeof draftModel.create === "function"
        ? await draftModel.create([draft])
        : typeof draftModel.insertOne === "function"
          ? await draftModel.insertOne(draft)
          : null;
      return { status: "created", draft: plain(Array.isArray(created) ? created[0] : created) ?? draft };
    } catch (error) {
      // A concurrent start can win the partial unique active-draft index.  A
      // readback makes the behavior deterministic without creating another
      // unbounded draft.
      const concurrent = await findActiveForGuild(guildId);
      if (concurrent) return {
        status: concurrent.actorUserId === actorUserId ? "resumed" : "busy",
        draft: concurrent,
      };
      throw error;
    }
  }

  async function updateDraft({ sessionId, guildId, actorUserId, feature, step, patch = null } = {}) {
    assertFeature(feature);
    const cleanPatch = patch === null ? null : safePatch(patch);
    const set = { updatedAt: dateValue(now()) };
    if (feature !== undefined) set.feature = feature;
    if (step !== undefined) set.step = String(step).slice(0, 80);
    if (cleanPatch !== null) set.patch = cleanPatch;
    const updated = await findOneAndUpdate(
      { ...activeFilter({ guildId, actorUserId }), sessionId },
      { $set: set },
    );
    if (!updated) throw new SetupDraftNotFoundError();
    return updated;
  }

  async function mergePatch({ sessionId, guildId, actorUserId, patch, feature, step } = {}) {
    const current = await getDraft(sessionId, { guildId, actorUserId });
    if (!current || current.status !== "active") throw new SetupDraftNotFoundError();
    const clean = safePatch(patch);
    return updateDraft({
      sessionId,
      guildId,
      actorUserId,
      feature: feature ?? current.feature,
      step: step ?? current.step,
      patch: { ...(current.patch ?? {}), ...clean },
    });
  }

  async function removePatchKey({ sessionId, guildId, actorUserId, key, feature, step } = {}) {
    const current = await getDraft(sessionId, { guildId, actorUserId });
    if (!current || current.status !== "active") throw new SetupDraftNotFoundError();
    const nextPatch = { ...(current.patch ?? {}) };
    delete nextPatch[key];
    return updateDraft({
      sessionId,
      guildId,
      actorUserId,
      feature: feature ?? current.feature,
      step: step ?? current.step,
      patch: nextPatch,
    });
  }

  async function selectFeature({ sessionId, guildId, actorUserId, feature, firstStep }) {
    assertFeature(feature);
    if (!feature) throw new Error("A setup feature is required.");
    // Feature selection starts a fresh feature draft.  Never carry values from
    // a previously selected feature into the new feature's allowlist.
    return updateDraft({ sessionId, guildId, actorUserId, feature, step: firstStep, patch: {} });
  }

  async function cancelDraft({ sessionId, guildId, actorUserId, reason = "cancelled" } = {}) {
    const updated = await findOneAndUpdate(
      { sessionId, guildId, actorUserId, status: "active" },
      { $set: { status: "cancelled", cancelledAt: dateValue(now()), lastError: boundedError(reason), updatedAt: dateValue(now()) } },
    );
    if (!updated) throw new SetupDraftConflictError("This setup draft is no longer active.");
    return updated;
  }

  async function claimCommit({ sessionId, guildId, actorUserId } = {}) {
    const draft = await getDraft(sessionId, { guildId, actorUserId });
    if (!draft) throw new SetupDraftNotFoundError();
    if (draft.status !== "active") throw new SetupDraftConflictError();
    if (draft.step !== "review") throw new SetupDraftConflictError("The setup draft is not ready for confirmation.");
    const claimed = await findOneAndUpdate(
      { sessionId, guildId, actorUserId, status: "active", step: "review", baseRevision: draft.baseRevision },
      { $set: { status: "committing", updatedAt: dateValue(now()), lastError: null } },
    );
    if (!claimed) throw new SetupDraftConflictError();
    return claimed;
  }

  async function completeDraft(draft, committed) {
    return findOneAndUpdate(
      { sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, status: "committing" },
      { $set: { status: "completed", committedRevision: revisionOf(committed), completedAt: dateValue(now()), updatedAt: dateValue(now()), lastError: null } },
    );
  }

  async function markCommitOutcome(draft, { status, error, committedRevision = null } = {}) {
    return findOneAndUpdate(
      { sessionId: draft.sessionId, guildId: draft.guildId, actorUserId: draft.actorUserId, status: "committing" },
      { $set: { status, committedRevision, lastError: error ? boundedError(error) : null, updatedAt: dateValue(now()) } },
    );
  }

  function cacheGet(cache, id) {
    if (!cache || !id) return null;
    if (typeof cache.get === "function") return cache.get(id) ?? null;
    return cache[id] ?? null;
  }

  function resourceGuildId(resource) {
    return resource?.guildId ?? resource?.guild?.id ?? resource?.guildID ?? null;
  }

  async function resolveSetupResource(guild, field, id) {
    const manager = field.type === "role" ? guild?.roles : guild?.channels;
    // Prefer a fresh API fetch at commit time.  A resource can remain in a
    // local cache after an administrator deletes or changes it during the
    // wizard's TTL, which is exactly the TOCTOU window this check closes.
    let resource;
    if (typeof manager?.fetch === "function") resource = await manager.fetch(id, { force: true });
    else resource = field.type === "role"
      ? cacheGet(guild?.roles?.cache, id)
      : cacheGet(guild?.channels?.cache, id);
    if (!resource) return { ok: false, reason: `${field.label}が見つかりません。` };
    const ownerGuildId = resourceGuildId(resource);
    if (ownerGuildId && ownerGuildId !== guild?.id) return { ok: false, reason: `${field.label}はこのサーバーの対象ではありません。` };
    if (field.type === "channel" && !field.channelTypes?.includes(resource.type)) {
      return { ok: false, reason: `${field.label}の種別が想定と異なります。` };
    }
    // Discord Role objects normally do not expose a `type` property.  If a
    // stale cache/test double does, it is evidence that the selected ID no
    // longer resolves to a role and must not reach the versioned writer.
    if (field.type === "role" && resource.type !== undefined) {
      return { ok: false, reason: `${field.label}にはロールを指定してください。` };
    }
    if (field.type === "role" && resource.id === guild?.id) return { ok: false, reason: `${field.label}には@everyoneを指定できません。` };
    return { ok: true, resource };
  }

  /**
   * The wizard validates a selected object while rendering its field, but a
   * draft can remain open for 30 minutes.  Recheck every explicitly selected
   * channel/role after the committing CAS and before the versioned write.
   */
  async function validateCommittedSetupResources(draft, currentSettings = {}) {
    if (typeof validateSetupResources === "function") {
      const result = await validateSetupResources(draft, currentSettings);
      if (result === false) return { ok: false, reason: "セットアップ対象のDiscordリソースを再確認できませんでした。" };
      if (result && result.ok === false) return result;
    }
    if (typeof getGuild !== "function") return { ok: true };
    const guild = await getGuild(draft.guildId);
    if (!guild?.id || guild.id !== draft.guildId) return { ok: false, reason: "対象サーバーを再確認できませんでした。" };
    const patch = draft.patch ?? {};
    // Validate the effective values visible for this feature, not only keys
    // present in the patch.  A wizard can intentionally keep an existing
    // optional channel/role for 30 minutes, so that resource is still subject
    // to the same final TOCTOU check.  Hidden dependencies and explicit
    // clears are intentionally excluded.
    for (const field of visibleSetupFields(draft.feature, patch, currentSettings ?? {})) {
      const value = hasOwn(patch, field.key) ? patch[field.key] : currentSettings?.[field.key];
      if (value === null || value === undefined || value === "") continue;
      if (field.type !== "channel" && field.type !== "role") continue;
      const resourceIds = field.type === "role" && field.key.endsWith("RoleIds")
        ? (Array.isArray(value) ? value : [value])
        : [value];
      for (const resourceId of resourceIds) {
        const result = await resolveSetupResource(guild, field, resourceId);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  }

  async function commitDraft({ sessionId, guildId, actorUserId, reason = null } = {}) {
    // Read inactive rows for the initial status check.  A second confirm
    // after a successful CAS claim should be reported as a conflict rather
    // than as a missing draft, while ownership and guild scoping remain
    // enforced by the same query.
    const draft = await getDraft(sessionId, { guildId, actorUserId, includeInactive: true });
    if (!draft) throw new SetupDraftNotFoundError();
    if (draft.status !== "active") throw new SetupDraftConflictError();
    if (draft.step !== "review") throw new SetupDraftConflictError("The setup draft is not on the review step.");
    const current = typeof getGuildSettings === "function"
      ? await getGuildSettings(guildId)
      : configurationService?.getCurrentConfiguration
        ? (await configurationService.getCurrentConfiguration(guildId))?.snapshot ?? {}
        : {};
    const validation = validateSetupDraft(draft.feature, draft.patch ?? {}, current ?? {});
    if (!validation.ok) {
      const error = new Error(`Setup draft is incomplete or contains unsupported fields: ${[
        ...(validation.unsupported ?? []),
        ...(validation.invalid ?? []).map((field) => field.key),
        ...(validation.missing ?? []).map((field) => field.key),
      ].join(", ")}`);
      error.code = "SETUP_DRAFT_INVALID";
      error.missing = validation.missing;
      error.unsupported = validation.unsupported;
      error.invalid = validation.invalid;
      throw error;
    }
    await claimCommit({ sessionId, guildId, actorUserId });
    // Read the row back after the active -> committing CAS.  This makes the
    // exact persisted patch the object being validated and written, even if a
    // test double or another process mutates the row at the claim boundary.
    const committedDraft = await getDraft(sessionId, { guildId, actorUserId, includeInactive: true });
    if (!committedDraft || committedDraft.status !== "committing") throw new SetupDraftConflictError();
    // A field interaction may have won the active-row race between the first
    // validation and the claim.  Re-read and validate the exact claimed patch
    // before invoking the versioned writer; an invalid claimed row is
    // terminally cancelled and never reaches GuildSettings.
    const claimedCurrent = typeof getGuildSettings === "function"
      ? await getGuildSettings(guildId)
      : configurationService?.getCurrentConfiguration
        ? (await configurationService.getCurrentConfiguration(guildId))?.snapshot ?? {}
        : {};
    const claimedValidation = validateSetupDraft(committedDraft.feature, committedDraft.patch ?? {}, claimedCurrent ?? {});
    if (!claimedValidation.ok) {
      await markCommitOutcome(committedDraft, {
        status: "cancelled",
        error: `Claimed setup draft changed or became invalid: ${[
          ...(claimedValidation.unsupported ?? []),
          ...(claimedValidation.invalid ?? []).map((field) => field.key),
          ...(claimedValidation.missing ?? []).map((field) => field.key),
        ].join(", ")}`,
      });
      const error = new Error("The setup draft changed before confirmation and is no longer valid.");
      error.code = "SETUP_DRAFT_INVALID";
      error.missing = claimedValidation.missing;
      error.unsupported = claimedValidation.unsupported;
      error.invalid = claimedValidation.invalid;
      throw error;
    }
    let resourceValidation;
    try {
      resourceValidation = await validateCommittedSetupResources(committedDraft, claimedCurrent ?? {});
    } catch (error) {
      resourceValidation = { ok: false, reason: `セットアップ対象のDiscordリソースを再確認できませんでした: ${boundedError(error)}` };
    }
    if (!resourceValidation?.ok) {
      const message = resourceValidation?.reason ?? "セットアップ対象のDiscordリソースが削除または変更されています。";
      await markCommitOutcome(committedDraft, { status: "cancelled", error: message }).catch((error) => {
        logger.warn?.(`Setup resource validation outcome could not be persisted for guild=${guildId}: ${error?.message ?? error}`);
      });
      const error = new SetupDraftResourceInvalidError(message);
      error.reason = resourceValidation?.reason ?? "resource-invalid";
      throw error;
    }
    const writerPatch = safePatch({
      ...committedDraft.patch,
      ...(hasOwn(committedDraft.patch, "kokuchiEventTime")
        ? { kokuchiEventTimeConfigured: typeof committedDraft.patch.kokuchiEventTime === "string" && committedDraft.patch.kokuchiEventTime.length > 0 }
        : {}),
    });
    const companionPatch = committedDraft.feature === "fukyo"
      && writerPatch.fukyoWeeklyThemeEnabled === true
      && claimedCurrent?.fukyoWeeklyThemeEnabled !== true
      ? { fukyoWeeklyThemeEnabledAt: dateValue(now()) }
      : {};
    try {
      const committed = await saveVersionedGuildConfiguration(committedDraft.guildId, writerPatch, {
        expectedRevision: committedDraft.baseRevision,
        actorUserId: committedDraft.actorUserId,
        source: "setup",
        reason: reason ?? `setup:${committedDraft.feature ?? "feature"}`,
        companionPatch,
      });
      await completeDraft(committedDraft, committed);
      return { status: "completed", draft: committedDraft, committed, revision: revisionOf(committed), apply: committed?.apply ?? committed?.applyJob ?? null };
    } catch (error) {
      if (error?.code === "CONFIGURATION_REVISION_CONFLICT") {
        await markCommitOutcome(committedDraft, { status: "cancelled", error: "Configuration revision conflict; setup was not rebased." });
        return { status: "conflict", draft: committedDraft, error };
      }
      // If the writer failed after a possible commit, inspect the current
      // revision.  A changed revision is deliberately not guessed as ours;
      // mark the draft cancelled and require a fresh setup instead of retrying
      // a possibly committed patch.
      try {
        const observedRevision = await currentRevision(committedDraft.guildId);
        if (observedRevision !== committedDraft.baseRevision) {
          await markCommitOutcome(committedDraft, { status: "cancelled", error: `Commit outcome ambiguous at revision ${observedRevision}.` });
          return { status: "unknown", draft: committedDraft, error, observedRevision };
        }
        await markCommitOutcome(committedDraft, { status: "cancelled", error: "No committed revision was observed; setup was not retried." });
        return { status: "failed", draft: committedDraft, error, observedRevision };
      } catch (readError) {
        logger.warn?.(`Setup commit outcome could not be read for guild=${committedDraft.guildId}: ${readError?.message ?? readError}`);
        return { status: "unknown", draft: committedDraft, error, readError };
      }
    }
  }

  return {
    cancelDraft,
    claimCommit,
    commitDraft,
    currentRevision,
    findActiveForActor,
    findActiveForGuild,
    getDraft,
    mergePatch,
    removePatchKey,
    selectFeature,
    startDraft,
    updateDraft,
  };
}

export { DEFAULT_TTL_MS, safePatch };
