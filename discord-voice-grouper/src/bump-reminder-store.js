import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const remindersPath = resolve(process.cwd(), "data", "bump-reminders.json");

let cache;

export async function getBumpReminders() {
  return Object.values(await readReminders());
}

export async function saveBumpReminder(reminder) {
  const reminders = await readReminders();
  reminders[reminder.id] = reminder;
  await writeReminders(reminders);
}

export async function deleteBumpReminder(reminderId) {
  const reminders = await readReminders();
  delete reminders[reminderId];
  await writeReminders(reminders);
}

async function readReminders() {
  if (cache) {
    return cache;
  }

  try {
    const raw = await readFile(remindersPath, "utf8");
    cache = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    cache = {};
  }

  return cache;
}

async function writeReminders(reminders) {
  await mkdir(dirname(remindersPath), { recursive: true });
  await writeFile(remindersPath, `${JSON.stringify(reminders, null, 2)}\n`);
  cache = reminders;
}
