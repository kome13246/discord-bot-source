import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mongoose from "mongoose";
import { BumpReminder } from "./models/bump-reminder.js";
import { MigrationState } from "./models/migration-state.js";

const remindersPath = resolve(process.cwd(), "data", "bump-reminders.json");
let cache;

export async function getBumpReminders() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("MongoDB is unavailable; bump reminders cannot be read.");
  }
  const migration = await MigrationState.findOne({ key: "bump-reminders-v1" }).lean();
  if (!migration) {
    const legacy = await readReminders();
    await Promise.all(Object.values(legacy).map((reminder) => saveBumpReminder(reminder)));
    await MigrationState.updateOne(
      { key: "bump-reminders-v1" },
      { $setOnInsert: { key: "bump-reminders-v1", completedAt: new Date() } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }
  const documents = await BumpReminder.find({}).lean();
  return documents.map(toReminder);
}

export async function saveBumpReminder(reminder) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; bump reminders cannot be saved.");
  await BumpReminder.findOneAndUpdate(
    { reminderId: reminder.id },
    { $set: { ...reminder, reminderId: reminder.id } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
}

export async function deleteBumpReminder(reminderId) {
  if (mongoose.connection.readyState !== 1) throw new Error("MongoDB is unavailable; bump reminders cannot be deleted.");
  await BumpReminder.deleteOne({ reminderId });
}

function toReminder(document) {
  const { _id, __v, reminderId, createdAt, updatedAt, ...reminder } = document;
  return { ...reminder, id: reminder.id ?? reminderId };
}

async function readReminders() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(remindersPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    cache = {};
  }
  return cache;
}
