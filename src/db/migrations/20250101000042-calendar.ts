import { DataTypes } from "sequelize";
import type { Migration } from "../umzug";
import { addRolePermissions, ignoreDuplicate } from "../migration-helpers";

// Meetings gain type, scope, location, agenda and reminders; attendees gain RSVP
// and attendance; notes, action items and calendar events are new (A401 to A404).
export const up: Migration = async ({ context: qi }) => {
  const stamps = () => ({ created_at: { type: DataTypes.DATE, allowNull: false }, updated_at: { type: DataTypes.DATE, allowNull: false } });
  const user = () => ({ type: DataTypes.UUID, allowNull: true, references: { model: "users", key: "id" }, onDelete: "SET NULL" });

  const meetings = await qi.describeTable("meetings");
  const addMeeting = async (name: string, spec: Parameters<typeof qi.addColumn>[2]) => {
    if (!meetings[name]) await qi.addColumn("meetings", name, spec);
  };
  await addMeeting("type", { type: DataTypes.STRING(12), allowNull: false, defaultValue: "other" });
  await addMeeting("scope_type", { type: DataTypes.STRING(14), allowNull: true });
  await addMeeting("scope_id", { type: DataTypes.UUID, allowNull: true });
  await addMeeting("status", { type: DataTypes.STRING(10), allowNull: false, defaultValue: "scheduled" });
  await addMeeting("location_type", { type: DataTypes.STRING(10), allowNull: false, defaultValue: "online" });
  await addMeeting("location", { type: DataTypes.STRING(300), allowNull: true });
  await addMeeting("has_meet_link", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
  await addMeeting("agenda", { type: DataTypes.JSONB, allowNull: false, defaultValue: [] });
  await addMeeting("reminder_minutes", { type: DataTypes.ARRAY(DataTypes.INTEGER), allowNull: false, defaultValue: [15] });
  await addMeeting("groups", { type: DataTypes.JSONB, allowNull: false, defaultValue: [] });
  await addMeeting("cancel_reason", { type: DataTypes.STRING(500), allowNull: true });
  await addMeeting("cancelled_at", { type: DataTypes.DATE, allowNull: true });
  await addMeeting("sync_state", { type: DataTypes.STRING(10), allowNull: false, defaultValue: "not_linked" });
  await qi.sequelize.query(`UPDATE meetings SET sync_state = 'synced' WHERE google_event_id IS NOT NULL AND sync_state = 'not_linked'`);
  await ignoreDuplicate(qi.addIndex("meetings", ["status", "starts_at"], { name: "meetings_status_starts" }));
  await ignoreDuplicate(qi.addIndex("meetings", ["scope_type", "scope_id"], { name: "meetings_scope" }));

  const attendees = await qi.describeTable("meeting_attendees");
  const addAttendee = async (name: string, spec: Parameters<typeof qi.addColumn>[2]) => {
    if (!attendees[name]) await qi.addColumn("meeting_attendees", name, spec);
  };
  // Rows made by older code get values from these defaults.
  await addAttendee("id", { type: DataTypes.UUID, allowNull: false, defaultValue: qi.sequelize.literal("gen_random_uuid()") });
  await addAttendee("rsvp", { type: DataTypes.STRING(10), allowNull: false, defaultValue: "pending" });
  await addAttendee("rsvp_note", { type: DataTypes.STRING(500), allowNull: true });
  await addAttendee("responded_at", { type: DataTypes.DATE, allowNull: true });
  await addAttendee("attendance", { type: DataTypes.STRING(10), allowNull: false, defaultValue: "unknown" });
  await addAttendee("attendance_marked_by", user());
  await addAttendee("updated_at", { type: DataTypes.DATE, allowNull: false, defaultValue: qi.sequelize.literal("now()") });
  await ignoreDuplicate(qi.addIndex("meeting_attendees", ["id"], { name: "meeting_attendees_id", unique: true }));
  await ignoreDuplicate(qi.addIndex("meeting_attendees", ["updated_at"], { name: "meeting_attendees_updated_at" }));
  await ignoreDuplicate(qi.addIndex("meeting_attendees", ["user_id"], { name: "meeting_attendees_user" }));
  // The organizer has already said yes by scheduling it.
  await qi.sequelize.query(`UPDATE meeting_attendees a SET rsvp = 'accepted' FROM meetings m WHERE a.meeting_id = m.id AND a.user_id = m.organizer_id AND a.rsvp = 'pending'`);

  const meetingRef = { type: DataTypes.UUID, allowNull: false, references: { model: "meetings", key: "id" }, onDelete: "CASCADE" };
  await ignoreDuplicate(
    qi.createTable("meeting_notes", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      meeting_id: meetingRef,
      kind: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "note" },
      body: { type: DataTypes.TEXT, allowNull: false },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("meeting_notes", ["meeting_id"], { name: "meeting_notes_meeting" }));
  await ignoreDuplicate(qi.addIndex("meeting_notes", ["updated_at"], { name: "meeting_notes_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("meeting_action_items", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      meeting_id: meetingRef,
      title: { type: DataTypes.STRING(300), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      owner_id: user(),
      due_date: { type: DataTypes.DATE, allowNull: true },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "open" },
      task_id: { type: DataTypes.UUID, allowNull: true, references: { model: "tasks", key: "id" }, onDelete: "SET NULL" },
      created_by: user(),
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("meeting_action_items", ["meeting_id"], { name: "meeting_action_items_meeting" }));
  await ignoreDuplicate(qi.addIndex("meeting_action_items", ["updated_at"], { name: "meeting_action_items_updated_at" }));

  await ignoreDuplicate(
    qi.createTable("calendar_events", {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      title: { type: DataTypes.STRING(200), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
      scope_type: { type: DataTypes.STRING(14), allowNull: false },
      scope_id: { type: DataTypes.UUID, allowNull: true },
      all_day: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      starts_at: { type: DataTypes.DATE, allowNull: false },
      ends_at: { type: DataTypes.DATE, allowNull: false },
      location: { type: DataTypes.STRING(300), allowNull: true },
      created_by: user(),
      cancelled_at: { type: DataTypes.DATE, allowNull: true },
      ...stamps(),
    }),
  );
  await ignoreDuplicate(qi.addIndex("calendar_events", ["starts_at"], { name: "calendar_events_starts" }));
  await ignoreDuplicate(qi.addIndex("calendar_events", ["scope_type", "scope_id"], { name: "calendar_events_scope" }));
  await ignoreDuplicate(qi.addIndex("calendar_events", ["updated_at"], { name: "calendar_events_updated_at" }));

  await addRolePermissions(qi, {
    chief: ["event.create", "event.edit", "event.delete"],
    product_manager: ["event.create", "event.edit", "event.delete"],
    department_head: ["event.create", "event.edit", "event.delete"],
    team_lead: ["event.create", "event.edit"],
    project_manager: ["event.create", "event.edit"],
    hr_officer: ["event.create", "event.edit", "event.delete"],
  });
};

export const down: Migration = async ({ context: qi }) => {
  for (const t of ["calendar_events", "meeting_action_items", "meeting_notes"]) await qi.dropTable(t);
  for (const c of ["updated_at", "attendance_marked_by", "attendance", "responded_at", "rsvp_note", "rsvp", "id"]) {
    await qi.removeColumn("meeting_attendees", c).catch(() => undefined);
  }
  for (const c of ["sync_state", "cancelled_at", "cancel_reason", "groups", "reminder_minutes", "agenda", "has_meet_link", "location", "location_type", "status", "scope_id", "scope_type", "type"]) {
    await qi.removeColumn("meetings", c).catch(() => undefined);
  }
};
