import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;
const REMINDER_DELAY_MS = 72 * 60 * 60 * 1_000;

export const DEFAULT_ALERT_DB_PATH =
  process.env.ALERTS_DB_PATH ?? "data/alerts.db";

export type AlertStatus = "notified" | "reminded" | "closed";
export type AlertCloseReason = "channel_replied" | "no_longer_qualifies";

export interface AlertCandidate {
  channelHandle: string;
  commentId: string;
  text: string;
  videoId: string;
  link: string;
  postedAt: string;
  creatorReplied: boolean;
  qualifies?: boolean;
}

export interface AlertStateRecord {
  channelHandle: string;
  commentId: string;
  state: AlertStatus;
  firstNotifiedAt: string | null;
  remindedAt: string | null;
  closedAt: string | null;
  closedReason: AlertCloseReason | null;
  commentText: string;
  videoId: string;
  link: string;
}

export interface AlertClosure {
  commentId: string;
  reason: AlertCloseReason;
}

export interface AlertClassification<
  T extends AlertCandidate = AlertCandidate,
> {
  newItems: T[];
  reminders: T[];
  toClose: AlertClosure[];
}

function validTime(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid alert state time.");
  return timestamp;
}

function key(channelHandle: string, commentId: string): string {
  return `${channelHandle}\u0000${commentId}`;
}

export function classifyCandidates<T extends AlertCandidate>(
  candidates: T[],
  state: AlertStateRecord[],
  now: Date,
): AlertClassification<T> {
  const nowTime = validTime(now);
  const stateByKey = new Map(
    state.map((record) => [
      key(record.channelHandle, record.commentId),
      record,
    ]),
  );
  const candidatesByKey = new Map(
    candidates.map((candidate) => [
      key(candidate.channelHandle, candidate.commentId),
      candidate,
    ]),
  );
  const result: AlertClassification<T> = {
    newItems: [],
    reminders: [],
    toClose: [],
  };

  for (const candidate of candidatesByKey.values()) {
    const postedTime = validTime(candidate.postedAt);
    const commentAge = nowTime - postedTime;
    const record = stateByKey.get(
      key(candidate.channelHandle, candidate.commentId),
    );
    if (!record) {
      if (
        candidate.qualifies !== false &&
        !candidate.creatorReplied &&
        commentAge >= 0 &&
        commentAge <= 7 * DAY_MS
      ) {
        result.newItems.push(candidate);
      }
      continue;
    }
    if (record.state === "closed" || record.state === "reminded") continue;
    if (candidate.creatorReplied) {
      result.toClose.push({
        commentId: candidate.commentId,
        reason: "channel_replied",
      });
      continue;
    }
    if (!record.firstNotifiedAt)
      throw new Error("Notified alert is missing its first notification time.");
    const firstNotifiedTime = validTime(record.firstNotifiedAt);
    if (
      candidate.qualifies === false ||
      commentAge < 0 ||
      commentAge > 7 * DAY_MS ||
      nowTime - firstNotifiedTime > 7 * DAY_MS
    ) {
      result.toClose.push({
        commentId: candidate.commentId,
        reason: "no_longer_qualifies",
      });
      continue;
    }
    if (
      record.state === "notified" &&
      nowTime - firstNotifiedTime >= REMINDER_DELAY_MS
    ) {
      result.reminders.push(candidate);
    }
  }

  for (const record of state) {
    if (record.state === "closed" || record.state === "reminded") continue;
    if (!candidatesByKey.has(key(record.channelHandle, record.commentId))) {
      result.toClose.push({
        commentId: record.commentId,
        reason: "no_longer_qualifies",
      });
    }
  }

  return result;
}

export class AlertStateStore {
  private readonly database: DatabaseSync;

  constructor(
    readonly path: string,
    options: { readOnly?: boolean } = {},
  ) {
    if (!options.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(
      path,
      options.readOnly ? { readOnly: true } : {},
    );
    if (!options.readOnly) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS alert_comments (
          channel_handle TEXT NOT NULL,
          comment_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('notified', 'reminded', 'closed')),
          first_notified_at TEXT,
          reminded_at TEXT,
          closed_at TEXT,
          closed_reason TEXT CHECK (closed_reason IS NULL OR closed_reason IN ('channel_replied', 'no_longer_qualifies')),
          comment_text TEXT NOT NULL,
          video_id TEXT NOT NULL,
          link TEXT NOT NULL,
          PRIMARY KEY (channel_handle, comment_id)
        );
        CREATE TABLE IF NOT EXISTS alert_channels (
          channel_handle TEXT PRIMARY KEY,
          last_successful_pass_at TEXT
        );
      `);
    }
  }

  close(): void {
    this.database.close();
  }

  getComments(channelHandle: string): AlertStateRecord[] {
    const rows = this.database
      .prepare(
        `SELECT channel_handle, comment_id, state, first_notified_at,
                reminded_at, closed_at, closed_reason, comment_text, video_id, link
         FROM alert_comments WHERE channel_handle = ?`,
      )
      .all(channelHandle) as {
      channel_handle: string;
      comment_id: string;
      state: string;
      first_notified_at: string | null;
      reminded_at: string | null;
      closed_at: string | null;
      closed_reason: string | null;
      comment_text: string;
      video_id: string;
      link: string;
    }[];
    return rows.map((row) => ({
      channelHandle: row.channel_handle,
      commentId: row.comment_id,
      state: row.state as AlertStatus,
      firstNotifiedAt: row.first_notified_at,
      remindedAt: row.reminded_at,
      closedAt: row.closed_at,
      closedReason: row.closed_reason as AlertCloseReason | null,
      commentText: row.comment_text,
      videoId: row.video_id,
      link: row.link,
    }));
  }

  getWatermark(channelHandle: string): Date | undefined {
    const row = this.database
      .prepare(
        "SELECT last_successful_pass_at FROM alert_channels WHERE channel_handle = ?",
      )
      .get(channelHandle) as
      { last_successful_pass_at: string | null } | undefined;
    return row?.last_successful_pass_at
      ? new Date(row.last_successful_pass_at)
      : undefined;
  }

  markNotified(
    channelHandle: string,
    items: AlertCandidate[],
    now: Date,
  ): void {
    const timestamp = new Date(validTime(now)).toISOString();
    this.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO alert_comments (
          channel_handle, comment_id, state, first_notified_at,
          comment_text, video_id, link
        ) VALUES (?, ?, 'notified', ?, ?, ?, ?)
        ON CONFLICT (channel_handle, comment_id) DO NOTHING
      `);
      for (const item of items) {
        insert.run(
          channelHandle,
          item.commentId,
          timestamp,
          item.text,
          item.videoId,
          item.link,
        );
      }
    });
  }

  markReminded(channelHandle: string, commentIds: string[], now: Date): void {
    const timestamp = new Date(validTime(now)).toISOString();
    this.transaction(() => {
      const update = this.database.prepare(`
        UPDATE alert_comments SET state = 'reminded', reminded_at = ?
        WHERE channel_handle = ? AND comment_id = ? AND state = 'notified'
      `);
      for (const commentId of commentIds)
        update.run(timestamp, channelHandle, commentId);
    });
  }

  closeComments(
    channelHandle: string,
    comments: AlertClosure[],
    now: Date,
  ): void {
    const timestamp = new Date(validTime(now)).toISOString();
    this.transaction(() =>
      this.closeCommentsInTransaction(channelHandle, comments, timestamp),
    );
  }

  setWatermark(channelHandle: string, time: Date): void {
    const timestamp = new Date(validTime(time)).toISOString();
    this.transaction(() =>
      this.setWatermarkInTransaction(channelHandle, timestamp),
    );
  }

  applySuccessfulPass(
    channelHandle: string,
    classification: AlertClassification,
    now: Date,
  ): void {
    const timestamp = new Date(validTime(now)).toISOString();
    this.transaction(() => {
      this.recordSuccessfulPassInTransaction(
        channelHandle,
        classification.newItems,
        classification.reminders.map((item) => item.commentId),
        classification.toClose,
        timestamp,
      );
    });
  }

  recordDraftSent(
    channelHandle: string,
    newItems: Omit<AlertCandidate, "channelHandle">[],
    remindedCommentIds: string[],
    toClose: AlertClosure[],
    now: Date,
  ): void {
    const timestamp = new Date(validTime(now)).toISOString();
    this.transaction(() =>
      this.recordSuccessfulPassInTransaction(
        channelHandle,
        newItems,
        remindedCommentIds,
        toClose,
        timestamp,
      ),
    );
  }

  private recordSuccessfulPassInTransaction(
    channelHandle: string,
    newItems: Omit<AlertCandidate, "channelHandle">[],
    remindedCommentIds: string[],
    toClose: AlertClosure[],
    timestamp: string,
  ): void {
    const insert = this.database.prepare(`
      INSERT INTO alert_comments (
        channel_handle, comment_id, state, first_notified_at,
        comment_text, video_id, link
      ) VALUES (?, ?, 'notified', ?, ?, ?, ?)
      ON CONFLICT (channel_handle, comment_id) DO NOTHING
    `);
    for (const item of newItems) {
      insert.run(
        channelHandle,
        item.commentId,
        timestamp,
        item.text,
        item.videoId,
        item.link,
      );
    }
    const remind = this.database.prepare(`
      UPDATE alert_comments SET state = 'reminded', reminded_at = ?
      WHERE channel_handle = ? AND comment_id = ? AND state = 'notified'
    `);
    for (const commentId of remindedCommentIds)
      remind.run(timestamp, channelHandle, commentId);
    this.closeCommentsInTransaction(channelHandle, toClose, timestamp);
    this.setWatermarkInTransaction(channelHandle, timestamp);
  }

  private closeCommentsInTransaction(
    channelHandle: string,
    comments: AlertClosure[],
    timestamp: string,
  ): void {
    const update = this.database.prepare(`
      UPDATE alert_comments
      SET state = 'closed', closed_at = ?, closed_reason = ?
      WHERE channel_handle = ? AND comment_id = ? AND state != 'closed'
    `);
    for (const comment of comments)
      update.run(timestamp, comment.reason, channelHandle, comment.commentId);
  }

  private setWatermarkInTransaction(
    channelHandle: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `
      INSERT INTO alert_channels (channel_handle, last_successful_pass_at)
      VALUES (?, ?)
      ON CONFLICT (channel_handle) DO UPDATE SET
        last_successful_pass_at = CASE
          WHEN excluded.last_successful_pass_at > alert_channels.last_successful_pass_at
          THEN excluded.last_successful_pass_at
          ELSE alert_channels.last_successful_pass_at
        END
    `,
      )
      .run(channelHandle, timestamp);
  }

  private transaction(operation: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function readAlertStateIfExists(
  path = DEFAULT_ALERT_DB_PATH,
): AlertStateStore | undefined {
  try {
    return new AlertStateStore(path, { readOnly: true });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("no such file") ||
        error.message.includes("unable to open database file"))
    ) {
      return undefined;
    }
    throw error;
  }
}
