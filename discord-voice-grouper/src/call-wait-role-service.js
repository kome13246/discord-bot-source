import crypto from "node:crypto";
import { PermissionFlagsBits } from "discord.js";
import { acquireMongoLease, releaseMongoLease } from "./mongo-lease-lock-store.js";
import { CallWaitRoleGeneration } from "./models/call-wait-role-generation.js";
import { VoiceParticipantRoleGrant } from "./models/voice-participant-role-grant.js";

export const CALL_WAIT_ROLE_GENERATION_ACTIVE_STATES = ["scheduled", "executing"];

export function createCallWaitRoleService({
  getGuildSettings,
  saveGuildSettings,
  generationModel = CallWaitRoleGeneration,
  roleGrantModel = VoiceParticipantRoleGrant,
  acquireLease = acquireMongoLease,
  releaseLease = releaseMongoLease,
  scheduleRemoval = null,
  removeMembers = null,
  sendOperationalLog = null,
  logger = console,
} = {}) {
  if (!getGuildSettings || !saveGuildSettings) throw new Error("getGuildSettings and saveGuildSettings are required.");

  async function log(guild, settings, content) {
    logger.info?.(content);
    if (!sendOperationalLog) return;
    await sendOperationalLog({ guild, settings, fallbackChannel: null, content }).catch((error) => logger.error?.("Call-wait role log failed", error));
  }

  function generationId() {
    return `callwait-generation-${Date.now().toString(36)}-${crypto.randomUUID()}`;
  }

  function uniqueMemberIds(memberIds) {
    return [...new Set((Array.isArray(memberIds) ? memberIds : []).filter((memberId) => typeof memberId === "string" && memberId.length > 0))];
  }

  async function getRole(guild, roleId) {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return { role: null, error: "call_wait_role が見つかりません。" };
    const botMember = guild.members.me ?? (typeof guild.members.fetchMe === "function" ? await guild.members.fetchMe().catch(() => null) : null);
    if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) return { role: null, error: "BotにManage Roles権限がありません。" };
    if (role.managed || role.id === guild.id || role.editable === false) return { role: null, error: "call_wait_roleを操作できません。ロール階層を確認してください。" };
    return { role, error: null };
  }

  async function getRoleHolders(guild, role) {
    const holders = new Map();
    for (const member of role.members?.values?.() ?? []) holders.set(member.id, member);
    for (const member of guild.members.cache?.values?.() ?? []) if (member.roles.cache?.has?.(role.id)) holders.set(member.id, member);
    if (guild.members.fetch) {
      let fetched;
      try {
        fetched = await guild.members.fetch();
      } catch (error) {
        throw new Error(`call_wait_roleの保持者取得に失敗しました: ${error.message}`);
      }
      for (const member of fetched?.values?.() ?? []) if (member.roles.cache?.has?.(role.id)) holders.set(member.id, member);
    }
    return [...holders.values()];
  }

  async function restoreRoleHolders(guild, role, memberIds, reason = "call_wait_role置換失敗からの復元") {
    const errors = [];
    for (const memberId of uniqueMemberIds(memberIds)) {
      const member = await guild.members.fetch(memberId).catch((error) => {
        errors.push(error);
        return null;
      });
      if (!member || member.roles.cache?.has?.(role.id)) continue;
      try {
        await member.roles.add(role, reason);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async function markGeneration(generation, patch) {
    return generationModel.findOneAndUpdate(
      { generationId: generation.generationId },
      { $set: patch },
      { returnDocument: "after", lean: true },
    );
  }

  async function removeGenerationMembers(guild, generation, reason = "call_wait_role世代の解除") {
    const errors = [];
    if (removeMembers) {
      try {
        await removeMembers(guild, generation.roleId, generation.memberIds, {
          sourceType: "call_wait_generation",
          sourceId: generation.generationId,
        });
      } catch (error) {
        errors.push(error);
      }
    } else {
      for (const memberId of uniqueMemberIds(generation.memberIds)) {
        const member = await guild.members.fetch(memberId).catch(() => null);
        if (!member || !member.roles.cache?.has?.(generation.roleId)) continue;
        try {
          await member.roles.remove(generation.roleId, reason);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    await roleGrantModel.updateMany(
      { guildId: guild.id, roleId: generation.roleId, sourceType: "call_wait_generation", sourceId: generation.generationId, grantedByBot: true },
      { $set: { status: errors.length ? "failed" : "removed", removedAt: errors.length ? null : new Date(), cleanupAt: errors.length ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), lastError: errors.length ? String(errors[0]?.message ?? errors[0]).slice(0, 1000) : null } },
    ).catch((error) => logger.error?.("Call-wait role grant cleanup persistence failed", error));
    if (errors.length) throw new AggregateError(errors, "call_wait_roleの世代解除に失敗しました。");
  }

  async function replaceRole({
    guild,
    roleId,
    memberIds,
    sourceType,
    sourceId,
    reason = "call_wait_roleの新しい世代を付与",
    removalDelayMs = 20 * 60 * 1000,
    requiredMemberCount = 1,
  }) {
    const targets = uniqueMemberIds(memberIds);
    const lease = await acquireLease(`call-wait-role:${guild.id}:${roleId}`, { leaseMs: 120_000 });
    if (!lease) return { ok: false, status: "busy", reason: "call_wait_roleの処理が別の操作で実行中です。" };
    let generation = null;
    let pendingGenerationId = null;
    let role = null;
    let currentSettings = null;
    let previousCallWaitRoleGeneration = null;
    let removedHolderIds = [];
    let replacementCommitted = false;
    const grantedMemberIds = [];
    try {
      const roleResult = await getRole(guild, roleId);
      role = roleResult.role;
      const { error } = roleResult;
      if (!role) return { ok: false, status: "invalid", reason: error };
      currentSettings = await getGuildSettings(guild.id);
      previousCallWaitRoleGeneration = currentSettings?.callWaitRoleGeneration ?? null;
      const holders = await getRoleHolders(guild, role);
      removedHolderIds = [];
      for (const holder of holders) {
        if (!holder.roles.cache?.has?.(roleId)) continue;
        try {
          await holder.roles.remove(roleId, "call_wait_roleの世代置換");
          removedHolderIds.push(holder.id);
        } catch (removeError) {
          await log(guild, currentSettings, `call_wait_role全解除失敗 guild=${guild.id} member=${holder.id} role=${roleId} error=${removeError.message}`);
          const restoreErrors = await restoreRoleHolders(guild, role, removedHolderIds, "Rollback partial call_wait_role replacement");
          for (const restoreError of restoreErrors) logger.error?.("Failed to restore call_wait_role holder after partial replacement failure", restoreError);
          return { ok: false, status: "failed", reason: "call_wait_roleの既存保持者を解除できませんでした。" };
        }
      }
      pendingGenerationId = generationId();
      const executeAt = new Date(Date.now() + removalDelayMs);
      generation = {
        guildId: guild.id,
        roleId,
        generationId: pendingGenerationId,
        sourceType,
        sourceId: sourceId ?? pendingGenerationId,
        memberIds: [],
        executeAt,
        status: "executing",
        grantedAt: new Date(),
      };
      await generationModel.create(generation);
      for (const memberId of targets) {
        const member = await guild.members.fetch(memberId).catch(() => null);
        if (!member || member.user?.bot) continue;
        try {
          await member.roles.add(role, reason);
          try {
            await roleGrantModel.updateOne(
              { guildId: guild.id, memberId: member.id, roleId, sourceType: "call_wait_generation", sourceId: pendingGenerationId },
              { $set: { grantedByBot: true, grantedAt: new Date(), status: "active", removedAt: null, cleanupAt: null, lastError: null }, $setOnInsert: { guildId: guild.id, memberId: member.id, roleId, sourceType: "call_wait_generation", sourceId: pendingGenerationId } },
              { upsert: true },
            );
          } catch (persistenceError) {
            await member.roles.remove(roleId, "Rollback untracked call_wait_role generation grant").catch(() => null);
            throw persistenceError;
          }
          grantedMemberIds.push(member.id);
          await generationModel.updateOne(
            { guildId: guild.id, generationId: pendingGenerationId },
            { $addToSet: { memberIds: member.id } },
          );
        } catch (grantError) {
          await log(guild, currentSettings, `call_wait_role付与失敗 guild=${guild.id} member=${member.id} role=${roleId} error=${grantError.message}`);
        }
      }
      if (grantedMemberIds.length < requiredMemberCount) {
        await roleGrantModel.updateMany(
          { guildId: guild.id, roleId, sourceType: "call_wait_generation", sourceId: pendingGenerationId, grantedByBot: true },
          { $set: { status: "failed", lastError: "Required call_wait_role member count was not reached." } },
        ).catch((error) => logger.error?.("Call-wait role grant failure persistence failed", error));
        const rollbackErrors = [];
        for (const memberId of grantedMemberIds) {
          const member = await guild.members.fetch(memberId).catch(() => null);
          await member?.roles.remove(roleId, "call_wait_role付与不足のロール巻き戻し").catch((error) => rollbackErrors.push(error));
        }
        await roleGrantModel.updateMany(
          { guildId: guild.id, roleId, sourceType: "call_wait_generation", sourceId: pendingGenerationId, grantedByBot: true, status: "failed" },
          {
            $set: {
              status: rollbackErrors.length ? "failed" : "removed",
              removedAt: rollbackErrors.length ? null : new Date(),
              cleanupAt: rollbackErrors.length ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              lastError: rollbackErrors.length ? String(rollbackErrors[0]?.message ?? rollbackErrors[0]).slice(0, 1000) : null,
            },
          },
        ).catch((error) => logger.error?.("Call-wait role rollback persistence failed", error));
        await markGeneration(generation, {
          status: "failed",
          completedAt: new Date(),
          lastError: "Required call_wait_role member count was not reached.",
        }).catch(() => null);
        const restoreErrors = await restoreRoleHolders(guild, role, removedHolderIds);
        for (const restoreError of restoreErrors) logger.error?.("Failed to restore call_wait_role holder after insufficient replacement grants", restoreError);
        return { ok: false, status: "failed", reason: "招集用ロールを必要な人数へ付与できませんでした。", grantedMemberIds };
      }
      generation = { ...generation, memberIds: grantedMemberIds, status: "scheduled" };
      await generationModel.updateOne(
        { guildId: guild.id, generationId: pendingGenerationId },
        { $set: { memberIds: grantedMemberIds, executeAt, status: "scheduled", lastError: null } },
      );
      await saveGuildSettings(guild.id, { callWaitRoleGeneration: { ...generation, executeAt: executeAt.toISOString(), status: "active" } });
      replacementCommitted = true;
      await generationModel.updateMany(
        {
          guildId: guild.id,
          roleId,
          generationId: { $ne: pendingGenerationId },
          status: { $in: CALL_WAIT_ROLE_GENERATION_ACTIVE_STATES },
        },
        { $set: { status: "superseded", supersededAt: new Date() } },
      ).catch((error) => logger.error?.("Call-wait role superseded generation persistence failed", error));
      await roleGrantModel.updateMany(
        {
          guildId: guild.id,
          roleId,
          sourceType: "call_wait_generation",
          sourceId: { $ne: pendingGenerationId },
          grantedByBot: true,
          status: { $in: ["active", "removing", "failed"] },
        },
        {
          $set: {
            status: "removed",
            removedAt: new Date(),
            cleanupAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            lastError: "Superseded by a newer call_wait_role generation.",
          },
        },
      ).catch((error) => logger.error?.("Call-wait role superseded grant persistence failed", error));
      if (scheduleRemoval) {
        await scheduleRemoval({
          actionKey: `callwait-role-generation-remove:${guild.id}:${pendingGenerationId}`,
          type: "callwait_role_generation_remove",
          guild,
          roleId,
          memberIds: grantedMemberIds,
          delayMs: removalDelayMs,
          payload: { generationId: pendingGenerationId, sourceType: "call_wait_generation", sourceId: pendingGenerationId },
        }).catch(async (error) => {
          const latestSettings = await getGuildSettings(guild.id).catch(() => currentSettings);
          await log(guild, latestSettings, `call_wait_role解除予定登録失敗 guild=${guild.id} generationId=${pendingGenerationId} error=${error.message}`).catch((logError) => logger.error?.("Call-wait role removal scheduling log failed", logError));
        });
      }
      const latestSettings = await getGuildSettings(guild.id).catch(() => currentSettings);
      await log(guild, latestSettings, `call_wait_role新世代 guild=${guild.id} generationId=${pendingGenerationId} sourceType=${sourceType} sourceId=${sourceId ?? ""} memberCount=${grantedMemberIds.length}`).catch((logError) => logger.error?.("Call-wait role generation log failed", logError));
      return { ok: true, status: "scheduled", generation: { ...generation, executeAt: executeAt.toISOString() }, grantedMemberIds };
    } catch (error) {
      if (generation && !replacementCommitted) {
        await markGeneration(generation, { status: "failed", lastError: String(error.message ?? error).slice(0, 1000) }).catch(() => null);
        const current = await getGuildSettings(guild.id).catch(() => null);
        if (current?.callWaitRoleGeneration?.generationId === generation.generationId) {
          await saveGuildSettings(guild.id, { callWaitRoleGeneration: previousCallWaitRoleGeneration }).catch((restoreError) => logger.error?.("Failed to restore previous call_wait_role generation state", restoreError));
        }
      }
      if (pendingGenerationId && !replacementCommitted) {
        await roleGrantModel.updateMany(
          { guildId: guild.id, roleId, sourceType: "call_wait_generation", sourceId: pendingGenerationId, grantedByBot: true },
          { $set: { status: "failed", lastError: String(error.message ?? error).slice(0, 1000) } },
        ).catch((persistenceError) => logger.error?.("Call-wait role grant failure persistence failed", persistenceError));
      }
      if (!replacementCommitted) {
        for (const memberId of grantedMemberIds) {
          const member = await guild.members.fetch(memberId).catch(() => null);
          await member?.roles.remove(roleId, "call_wait_role処理失敗の巻き戻し").catch(() => null);
        }
      }
      if (!replacementCommitted && role) {
        const restoreErrors = await restoreRoleHolders(guild, role, removedHolderIds);
        for (const restoreError of restoreErrors) logger.error?.("Failed to restore call_wait_role holder after replacement failure", restoreError);
      }
      return { ok: false, status: "failed", reason: String(error?.message ?? error), error };
    } finally {
      await releaseLease(lease).catch((error) => logger.error?.("Failed to release call-wait role lease", error));
    }
  }

  async function executeGenerationRemoval({ guild, generationId: targetGenerationId }) {
    const generation = await generationModel.findOneAndUpdate(
      { guildId: guild.id, generationId: targetGenerationId, status: "scheduled" },
      { $set: { status: "executing" } },
      { returnDocument: "after", lean: true },
    );
    if (!generation) return { status: "ignored" };
    const roleLease = await acquireLease(`call-wait-role:${guild.id}:${generation.roleId}`, { leaseMs: 120_000 });
    if (!roleLease) {
      await markGeneration(generation, { status: "scheduled", lastError: "call_wait_role replacement is in progress" });
      return { status: "busy" };
    }
    try {
      const settings = await getGuildSettings(guild.id);
      if (settings?.callWaitRoleGeneration?.generationId !== targetGenerationId) {
        await markGeneration(generation, { status: "superseded", supersededAt: new Date() });
        return { status: "superseded" };
      }
      await removeGenerationMembers(guild, generation);
      await markGeneration(generation, { status: "completed", completedAt: new Date(), lastError: null });
      await saveGuildSettings(guild.id, { callWaitRoleGeneration: null });
      await log(guild, settings, `call_wait_role解除 guild=${guild.id} generationId=${targetGenerationId} memberCount=${generation.memberIds.length}`);
      return { status: "completed", memberIds: generation.memberIds };
    } catch (error) {
      await markGeneration(generation, { status: "failed", lastError: String(error?.message ?? error).slice(0, 1000) });
      return { status: "failed", error };
    } finally {
      await releaseLease(roleLease).catch((error) => logger.error?.("Failed to release call-wait role removal lease", error));
    }
  }

  async function rollbackGeneration({ guild, generationId: targetGenerationId, reason = "call_wait_role処理の巻き戻し" }) {
    const generation = await generationModel.findOne({ guildId: guild.id, generationId: targetGenerationId }).lean();
    if (!generation) return { status: "absent" };
    const roleLease = await acquireLease(`call-wait-role:${guild.id}:${generation.roleId}`, { leaseMs: 120_000 });
    if (!roleLease) return { status: "busy" };
    try {
      await removeGenerationMembers(guild, generation, reason);
      await markGeneration(generation, { status: "failed", lastError: reason, completedAt: new Date() });
      const settings = await getGuildSettings(guild.id);
      if (settings?.callWaitRoleGeneration?.generationId === targetGenerationId) await saveGuildSettings(guild.id, { callWaitRoleGeneration: null });
      return { status: "rolled-back" };
    } catch (error) {
      await markGeneration(generation, { status: "failed", lastError: String(error?.message ?? error).slice(0, 1000) });
      return { status: "failed", error };
    } finally {
      await releaseLease(roleLease).catch((error) => logger.error?.("Failed to release call-wait role rollback lease", error));
    }
  }

  async function restore(guild, { schedule = true } = {}) {
    // A process can stop after claiming a generation for removal but before
    // the Discord role operation finishes. Treat that claim as recoverable;
    // the generation ID check below still prevents an obsolete generation
    // from removing a later replacement.
    await generationModel.updateMany(
      { guildId: guild.id, status: "executing" },
      { $set: { status: "scheduled", lastError: "Recovered an interrupted call_wait_role removal" } },
    );
    const generations = await generationModel.find({ guildId: guild.id, status: "scheduled" }).lean();
    const grantsByGeneration = new Map();
    if (typeof roleGrantModel.find === "function") {
      const grantQuery = roleGrantModel.find({
        guildId: guild.id,
        sourceType: "call_wait_generation",
        grantedByBot: true,
        status: { $in: ["active", "removing", "failed"] },
      });
      const grants = grantQuery?.lean ? await grantQuery.lean() : await grantQuery;
      for (const grant of grants ?? []) {
        if (!grant?.sourceId || !grant.memberId) continue;
        const memberIds = grantsByGeneration.get(grant.sourceId) ?? [];
        memberIds.push(grant.memberId);
        grantsByGeneration.set(grant.sourceId, memberIds);
      }
    }
    for (const generation of generations) {
      const memberIds = uniqueMemberIds([
        ...(generation.memberIds ?? []),
        ...(grantsByGeneration.get(generation.generationId) ?? []),
      ]);
      if (memberIds.length === uniqueMemberIds(generation.memberIds).length) {
        generation.memberIds = memberIds;
        continue;
      }
      generation.memberIds = memberIds;
      await generationModel.updateOne(
        { guildId: guild.id, generationId: generation.generationId },
        { $set: { memberIds } },
      ).catch((error) => logger.error?.("Call-wait role generation member recovery failed", error));
    }
    const currentSettings = await getGuildSettings(guild.id);
    const currentGenerationId = currentSettings?.callWaitRoleGeneration?.generationId ?? null;
    const latestGeneration = generations
      .slice()
      .sort((left, right) => new Date(right.createdAt ?? right.grantedAt ?? 0).getTime() - new Date(left.createdAt ?? left.grantedAt ?? 0).getTime())[0] ?? null;
    if (currentGenerationId && !generations.some((generation) => generation.generationId === currentGenerationId)) {
      await saveGuildSettings(guild.id, { callWaitRoleGeneration: null }).catch((error) => logger.error?.("Call-wait role generation state cleanup failed", error));
    } else if (latestGeneration && currentGenerationId !== latestGeneration.generationId) {
      await saveGuildSettings(guild.id, {
        callWaitRoleGeneration: {
          ...latestGeneration,
          executeAt: new Date(latestGeneration.executeAt).toISOString(),
          status: "active",
        },
      }).catch((error) => logger.error?.("Call-wait role generation state repair failed", error));
    }
    for (const generation of generations) {
      if (!schedule) continue;
      if (!scheduleRemoval) continue;
      await scheduleRemoval({
        actionKey: `callwait-role-generation-remove:${guild.id}:${generation.generationId}`,
        type: "callwait_role_generation_remove",
        guild,
        roleId: generation.roleId,
        memberIds: generation.memberIds,
        delayMs: Math.max(0, new Date(generation.executeAt).getTime() - Date.now()),
        payload: { generationId: generation.generationId, sourceType: "call_wait_generation", sourceId: generation.generationId },
      });
    }
    return generations;
  }

  return { replaceRole, executeGenerationRemoval, rollbackGeneration, restore, getRoleHolders };
}
