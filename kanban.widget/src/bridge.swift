// reminders-kanban — Apple Reminders helper for the Kanban widget and for AI assistants (MCP).
//
// Widget / CLI commands
//   list                          JSON: tasks + order + projects
//   add     <text>                smart add: "Pay rent tomorrow 3pm !" (date → deadline + alert, ! → Doing)
//   move    <id> <todo|doing|done>
//   update  <id> <json>           {"title","notes","url","due":"<iso|natural>|none","project":"<key>|none|auto","status"}
//   project <id> <key|none|auto>
//   order   <json-array-of-ids>
//   import  <json>                one-time import of {order, assign} from older widget versions
//   delete  <id>
//   doctor                        health check
//   mcp                           run as an MCP server over stdio (for Claude, Cursor, Codex, …)
//   version
//
// Status mapping: Doing = high priority (!!!), Done = completed (last 3 days shown).
// Projects and manual order live in ~/Library/Application Support/Reminders Kanban/data.json
import EventKit
import Foundation

let VERSION = "1.2.2"
let store = EKEventStore()

// MARK: - output

func out(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
func errOut(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func fail(_ s: String) -> Never { errOut(s); exit(1) }

struct KError: Error, CustomStringConvertible { let description: String; init(_ s: String) { description = s } }

func json(_ obj: Any) -> String {
  String(data: try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), encoding: .utf8)!
}
func parseJSON(_ s: String) -> Any? { s.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } }

// MARK: - shared data file (projects + manual order)

let home = ProcessInfo.processInfo.environment["HOME"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser
let dataDir = home.appendingPathComponent("Library/Application Support/Reminders Kanban")
// Demo mode (for screenshots): while this flag file exists, only the "Kanban Demo" list is used,
// with its own projects/order file, so real tasks never appear on screen.
let demoMode = FileManager.default.fileExists(atPath: dataDir.appendingPathComponent("demo").path)
let dataURL = dataDir.appendingPathComponent(demoMode ? "demo-data.json" : "data.json")
let widgetDir = home.appendingPathComponent("Library/Application Support/Übersicht/widgets/kanban.widget")

let defaultProjects: [[String: Any]] = [
  ["key": "work", "label": "Work", "color": "#BF5AF2",
   "words": ["meeting", "report", "client", "deploy", "review", "code", "project", "presentation"]],
  ["key": "personal", "label": "Personal", "color": "#FF375F",
   "words": ["call", "birthday", "gym", "doctor", "friend", "family", "book"]],
  ["key": "home", "label": "Home", "color": "#40C8E0",
   "words": ["clean", "groceries", "laundry", "fix", "buy", "garden", "shop"]],
  ["key": "admin", "label": "Admin", "color": "#98989D",
   "words": ["email", "bank", "statement", "tax", "visa", "invoice", "pay", "bill", "account", "insurance"]],
]
let palette = ["#BF5AF2", "#FF375F", "#40C8E0", "#98989D", "#FFD60A", "#64D2FF", "#AC8E68", "#5E5CE6", "#FF9F0A"]

struct KData {
  var order: [String] = []
  var assign: [String: String] = [:]      // task id → project key ("" = no project)
  var projects: [[String: Any]] = defaultProjects
  var linksInNotes = false                // links copied into notes once (v1.1.2)

  static func load() -> KData {
    var d = KData()
    guard let raw = try? Data(contentsOf: dataURL),
          let obj = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] else { return d }
    d.order = obj["order"] as? [String] ?? []
    d.assign = obj["assign"] as? [String: String] ?? [:]
    if let p = obj["projects"] as? [[String: Any]], !p.isEmpty { d.projects = p }
    d.linksInNotes = obj["linksInNotes"] as? Bool ?? false
    return d
  }
  func save() {
    try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
    let obj: [String: Any] = ["order": order, "assign": assign, "projects": projects, "linksInNotes": linksInNotes,
                              "version": VERSION]
    if let raw = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]) {
      try? raw.write(to: dataURL, options: .atomic)
    }
  }
  var fresh: Bool { order.isEmpty && assign.isEmpty }

  func label(_ key: String?) -> String? {
    guard let key = key else { return nil }
    return projects.first { $0["key"] as? String == key }?["label"] as? String
  }
  func projectKey(for r: EKReminder) -> String? {
    if let a = assign[r.calendarItemIdentifier] { return a.isEmpty ? nil : a }
    let t = (r.title ?? "").lowercased()
    for p in projects {
      let words = p["words"] as? [String] ?? []
      if words.contains(where: { !$0.isEmpty && t.contains($0.lowercased()) }) { return p["key"] as? String }
    }
    return nil
  }
  /// Find a project by key or label (case-insensitive); create it if it doesn't exist.
  mutating func resolveProject(_ name: String) -> String {
    let n = name.trimmingCharacters(in: .whitespaces).lowercased()
    if let p = projects.first(where: { ($0["key"] as? String)?.lowercased() == n || ($0["label"] as? String)?.lowercased() == n }) {
      return p["key"] as! String
    }
    let key = n.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    let label = name.trimmingCharacters(in: .whitespaces)
    projects.append(["key": key.isEmpty ? "p\(projects.count)" : key,
                     "label": label.prefix(1).uppercased() + label.dropFirst(),
                     "color": palette[projects.count % palette.count], "words": []])
    return projects.last!["key"] as! String
  }
}

// MARK: - Reminders access

func hasAccess() -> Bool { EKEventStore.authorizationStatus(for: .reminder) == .fullAccess }

func ensureAccess() throws {
  if hasAccess() { return }
  let sem = DispatchSemaphore(value: 0)
  var granted = false
  store.requestFullAccessToReminders { ok, _ in granted = ok; sem.signal() }
  sem.wait()
  if !granted {
    throw KError("No access to Reminders. Open System Settings → Privacy & Security → Reminders and allow the app that runs this tool (e.g. Übersicht, Terminal or Claude), then try again.")
  }
}

func fetch(_ p: NSPredicate) -> [EKReminder] {
  var res: [EKReminder] = []
  let s = DispatchSemaphore(value: 0)
  store.fetchReminders(matching: p) { r in res = r ?? []; s.signal() }
  s.wait(); return res
}
var demoCalendarCache: EKCalendar?
func demoCalendar() -> EKCalendar? {
  if let c = demoCalendarCache { return c }
  if let c = store.calendars(for: .reminder).first(where: { $0.title == "Kanban Demo" }) { demoCalendarCache = c; return c }
  guard let source = store.defaultCalendarForNewReminders()?.source else { return nil }
  let c = EKCalendar(for: .reminder, eventStore: store)
  c.title = "Kanban Demo"; c.source = source
  try? store.saveCalendar(c, commit: true)
  demoCalendarCache = c; return c
}
func scope() -> [EKCalendar]? { demoMode ? demoCalendar().map { [$0] } : nil }

func openReminders() -> [EKReminder] {
  fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: scope()))
    .sorted { ($0.creationDate ?? .distantPast) < ($1.creationDate ?? .distantPast) }
}
func recentDone() -> [EKReminder] {
  fetch(store.predicateForCompletedReminders(withCompletionDateStarting: Date().addingTimeInterval(-3 * 86400),
                                             ending: Date(), calendars: scope()))
    .sorted { ($0.completionDate ?? .distantPast) > ($1.completionDate ?? .distantPast) }
}
func status(_ r: EKReminder) -> String { r.isCompleted ? "done" : (r.priority == 1 ? "doing" : "todo") }

func save(_ r: EKReminder) throws {
  do { try store.save(r, commit: true) } catch { throw KError("Couldn't save: \(error.localizedDescription)") }
}

/// Find a reminder by id, or by a unique piece of its title (open tasks first).
func resolve(_ ref: String) throws -> EKReminder {
  if let r = store.calendarItem(withIdentifier: ref) as? EKReminder,
     !demoMode || r.calendar.title == "Kanban Demo" { return r }
  let needle = ref.lowercased().trimmingCharacters(in: .whitespaces)
  guard !needle.isEmpty else { throw KError("Missing task id.") }
  for pool in [openReminders(), recentDone()] {
    if let exact = pool.first(where: { ($0.title ?? "").lowercased() == needle }) { return exact }
    let hits = pool.filter { ($0.title ?? "").lowercased().contains(needle) }
    if hits.count == 1 { return hits[0] }
    if hits.count > 1 {
      throw KError("\"\(ref)\" matches several tasks: " + hits.prefix(6).map { "\"\($0.title ?? "")\" (id \($0.calendarItemIdentifier))" }.joined(separator: ", ") + ". Use the id.")
    }
  }
  throw KError("No task found for \"\(ref)\". Call list_tasks to see ids.")
}

// MARK: - dates

let iso = ISO8601DateFormatter()
struct When { let date: Date; let allDay: Bool }

/// Does a natural-language phrase name a time of day? ("tomorrow" no, "tomorrow 3pm" yes)
func mentionsTime(_ s: String) -> Bool {
  s.range(of: "\\d\\s*(am|pm|a\\.m\\.|p\\.m\\.)|\\d:\\d\\d|\\b(noon|midnight|morning|afternoon|evening|tonight|night|at \\d)",
          options: [.regularExpression, .caseInsensitive]) != nil
}

/// ISO 8601, <input type=datetime-local>, a plain date (all-day), or natural language
/// ("tomorrow 3pm" = timed, "next Friday" = all-day, like the Reminders app).
func parseWhen(_ s: String) -> When? {
  let t = s.trimmingCharacters(in: .whitespaces)
  if let d = iso.date(from: t) { return When(date: d, allDay: false) }
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: t) { return When(date: d, allDay: false) }
  for fmt in ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
    let l = DateFormatter(); l.dateFormat = fmt; l.timeZone = .current; l.locale = Locale(identifier: "en_US_POSIX")
    if let d = l.date(from: t) { return When(date: d, allDay: fmt == "yyyy-MM-dd") }
  }
  if let det = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue),
     let m = det.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)), let d = m.date {
    return When(date: d, allDay: !mentionsTime(t))
  }
  return nil
}

let allDayAlertHour = 9

/// Timed: due at that minute, alert then. All-day: due that day, alert at 9:00 if that's still ahead.
func setDue(_ r: EKReminder, _ w: When?) {
  (r.alarms ?? []).forEach { r.removeAlarm($0) }
  guard let w = w else { r.dueDateComponents = nil; return }
  let cal = Calendar.current
  if w.allDay {
    r.dueDateComponents = cal.dateComponents([.calendar, .year, .month, .day], from: w.date)
    if let a = cal.date(bySettingHour: allDayAlertHour, minute: 0, second: 0, of: w.date), a > Date() {
      r.addAlarm(EKAlarm(absoluteDate: a))
    }
  } else {
    r.dueDateComponents = cal.dateComponents([.calendar, .timeZone, .year, .month, .day, .hour, .minute], from: w.date)
    r.addAlarm(EKAlarm(absoluteDate: w.date))
  }
}
func dueDate(_ r: EKReminder) -> Date? { r.dueDateComponents.flatMap { Calendar.current.date(from: $0) } }
func isAllDay(_ r: EKReminder) -> Bool { r.dueDateComponents != nil && r.dueDateComponents?.hour == nil }
/// An all-day task is only late once its day is over.
func isOverdue(_ r: EKReminder) -> Bool {
  guard !r.isCompleted, let d = dueDate(r) else { return false }
  let end = isAllDay(r) ? Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: d))! : d
  return end <= Date()
}
let dayOnly: DateFormatter = {
  let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = .current; return f
}()
let humanDay: DateFormatter = { let f = DateFormatter(); f.dateFormat = "EEE d MMM yyyy"; return f }()

func setStatus(_ r: EKReminder, _ s: String) throws {
  switch s.lowercased().replacingOccurrences(of: " ", with: "") {
  case "done", "complete", "completed": r.isCompleted = true; if r.priority == 1 { r.priority = 0 }
  case "doing", "inprogress", "progress": r.isCompleted = false; r.priority = 1
  case "todo", "open": r.isCompleted = false; if r.priority == 1 { r.priority = 0 }
  default: throw KError("Unknown status \"\(s)\". Use todo, doing or done.")
  }
}

func normalizeURL(_ s: String) -> URL? {
  let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
  if t.isEmpty { return nil }
  if t.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*:", options: .regularExpression) != nil { return URL(string: t) }
  return URL(string: "https://" + t)
}

// MARK: - links
// Apple's Reminders app ignores EKReminder.url (it has its own private URL field), so the link is
// also kept as the last line of the notes, "🔗 <url>", where it shows and is clickable everywhere.

let linkMark = "🔗"

/// Split notes into (description, link-from-notes).
func splitNotes(_ notes: String?) -> (String, String?) {
  let n = (notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  var lines = n.components(separatedBy: "\n")
  guard let last = lines.last?.trimmingCharacters(in: .whitespaces), last.hasPrefix(linkMark) else { return (n, nil) }
  let u = String(last.dropFirst(linkMark.count)).trimmingCharacters(in: .whitespaces)
  lines.removeLast()
  return (lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), u.isEmpty ? nil : u)
}

func joinNotes(_ desc: String, _ link: String?) -> String? {
  let d = desc.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let l = link, !l.isEmpty else { return d.isEmpty ? nil : d }
  return d.isEmpty ? "\(linkMark) \(l)" : "\(d)\n\n\(linkMark) \(l)"
}

func taskDesc(_ r: EKReminder) -> String { splitNotes(r.notes).0 }
/// The notes line is the source of truth, so removing it in the Reminders app removes the link.
func taskLink(_ r: EKReminder) -> String { splitNotes(r.notes).1 ?? "" }

/// One time: copy links that only live in EKReminder.url into the notes (tasks saved by v1.1.0 and older).
func migrateLinks(_ rs: [EKReminder]) {
  for r in rs {
    guard let u = r.url?.absoluteString, !u.isEmpty, splitNotes(r.notes).1 == nil else { continue }
    r.notes = joinNotes(splitNotes(r.notes).0, u)
    try? store.save(r, commit: true)
  }
}

// MARK: - task output

func taskDict(_ r: EKReminder, _ data: KData) -> [String: Any] {
  var d: [String: Any] = ["id": r.calendarItemIdentifier, "title": r.title ?? "", "list": r.calendar.title,
                          "status": status(r), "notes": taskDesc(r), "url": taskLink(r)]
  if let dc = r.dueDateComponents, let dt = Calendar.current.date(from: dc) {
    d["due"] = iso.string(from: dt); d["hasTime"] = dc.hour != nil
  }
  if let p = data.projectKey(for: r) { d["project"] = p }
  return d
}

let human: DateFormatter = { let f = DateFormatter(); f.dateFormat = "EEE d MMM yyyy, HH:mm"; return f }()
let statusLabel = ["todo": "To Do", "doing": "Doing", "done": "Done"]

func describe(_ r: EKReminder, _ data: KData) -> String {
  var parts = ["\(statusLabel[status(r)]!)"]
  if let d = dueDate(r) {
    parts.append("due \(isAllDay(r) ? humanDay.string(from: d) + " (all day)" : human.string(from: d))" + (isOverdue(r) ? " (OVERDUE)" : ""))
  }
  if let p = data.label(data.projectKey(for: r)) { parts.append("project \(p)") }
  var s = "• \(r.title ?? "") — \(parts.joined(separator: ", ")) [id: \(r.calendarItemIdentifier)]"
  let u = taskLink(r), n = taskDesc(r)
  if !u.isEmpty { s += "\n    link: \(u)" }
  if !n.isEmpty { s += "\n    description: " + n.replacingOccurrences(of: "\n", with: "\n      ") }
  return s
}

// MARK: - operations shared by CLI and MCP

/// Apply fields: title, notes/description, url/link, due, project, status. Returns what changed.
@discardableResult
func applyUpdate(_ r: EKReminder, _ f: [String: Any], _ data: inout KData) throws -> [String] {
  var changed: [String] = []
  if let t = f["title"] as? String {
    let v = t.trimmingCharacters(in: .whitespaces)
    guard !v.isEmpty else { throw KError("Title can't be empty.") }
    r.title = v; changed.append("title")
  }
  var desc = taskDesc(r), link = taskLink(r)
  if let n = (f["notes"] ?? f["description"]) as? String { desc = n; changed.append("description") }
  if let u = (f["url"] ?? f["link"]) as? String {
    link = normalizeURL(u)?.absoluteString ?? ""; changed.append("link")
  }
  if changed.contains("description") || changed.contains("link") { r.notes = joinNotes(desc, link); r.url = link.isEmpty ? nil : URL(string: link) }
  if f.keys.contains("due") {
    let v = f["due"] as? String ?? "none"
    if ["", "none", "null", "clear"].contains(v.lowercased()) { setDue(r, nil) }
    else { guard let w = parseWhen(v) else { throw KError("Couldn't understand the date \"\(v)\".") }; setDue(r, w) }
    changed.append("deadline")
  }
  if let s = f["status"] as? String { try setStatus(r, s); changed.append("status") }
  if let p = f["project"] as? String {
    let id = r.calendarItemIdentifier
    switch p.lowercased() {
    case "", "none": data.assign[id] = ""
    case "auto": data.assign.removeValue(forKey: id)
    default: data.assign[id] = data.resolveProject(p)
    }
    changed.append("project")
  }
  return changed
}

func createTask(title: String, fields: [String: Any], data: inout KData) throws -> EKReminder {
  guard let cal = demoMode ? demoCalendar() : store.defaultCalendarForNewReminders() else { throw KError("No default Reminders list found.") }
  let r = EKReminder(eventStore: store); r.calendar = cal; r.title = title
  var f = fields; f.removeValue(forKey: "title")
  let wantsProject = f.removeValue(forKey: "project")
  try applyUpdate(r, f, &data)
  try save(r)
  if let p = wantsProject { try applyUpdate(r, ["project": p], &data) }   // needs the saved id
  return r
}

/// "Pay rent tomorrow 3pm !" → title + deadline (+ Doing)
func smartParse(_ input: String) -> (String, When?, Bool) {
  var text = input.trimmingCharacters(in: .whitespaces)
  var doing = false
  if text.hasSuffix("!") { doing = true; text = String(text.dropLast()).trimmingCharacters(in: .whitespaces) }
  var due: When? = nil
  if let det = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue),
     let m = det.matches(in: text, range: NSRange(text.startIndex..., in: text)).last,
     let d = m.date, let range = Range(m.range, in: text) {
    due = When(date: d, allDay: !mentionsTime(String(text[range])))
    text.removeSubrange(range)
    text = text.replacingOccurrences(of: "\\s+(at|on|by)\\s*$", with: "", options: .regularExpression)
      .replacingOccurrences(of: "\\s{2,}", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
  }
  return (text, due, doing)
}

// MARK: - MCP server (JSON-RPC 2.0 over stdio, one message per line)

func toolDefs(_ data: KData) -> [[String: Any]] {
  let projects = data.projects.compactMap { $0["label"] as? String }.joined(separator: ", ")
  let tz = TimeZone.current.identifier
  let now = human.string(from: Date())
  let status: [String: Any] = ["type": "string", "enum": ["todo", "doing", "done"]]
  let dueDesc = "Deadline. ISO 8601 (e.g. 2026-12-01T15:00) or plain English like \"tomorrow 3pm\" / \"next Friday 9am\". "
    + "A date without a time (\"2026-12-01\", \"next Friday\") makes it an all-day task, like the Reminders app. "
    + "The user's local time zone is \(tz); it is now \(now). An alert fires at the time, or at 9:00 for all-day tasks."
  return [
    ["name": "list_tasks",
     "description": "List the user's tasks from their desktop Kanban board (Apple Reminders). Returns titles, status, deadlines, projects, links, descriptions and ids. Projects: \(projects).",
     "inputSchema": ["type": "object", "properties": [
        "status": ["type": "string", "enum": ["open", "todo", "doing", "done", "all"], "description": "Default: open (To Do + Doing). Done shows the last 3 days."],
        "project": ["type": "string", "description": "Only tasks in this project."],
        "due": ["type": "string", "enum": ["overdue", "today", "week", "any"], "description": "Only overdue tasks, tasks due today, due within 7 days, or any task with a deadline."],
        "query": ["type": "string", "description": "Only tasks whose title or description contains this text."]]],
     "annotations": ["readOnlyHint": true]],
    ["name": "add_task",
     "description": "Add a task to the user's Kanban board. It appears on their desktop widget within seconds and syncs to Reminders on their iPhone. Projects: \(projects) (a new name creates a new project).",
     "inputSchema": ["type": "object", "required": ["title"], "properties": [
        "title": ["type": "string", "description": "Short task title."],
        "description": ["type": "string", "description": "Optional details, notes or steps."],
        "link": ["type": "string", "description": "Optional URL."],
        "due": ["type": "string", "description": dueDesc],
        "status": ["type": "string", "enum": ["todo", "doing"], "description": "Column. Default: todo."],
        "project": ["type": "string", "description": "Project name."]]]],
    ["name": "update_task",
     "description": "Change a task: title, description, link, deadline, project or status. Only the fields you pass are changed. Use \"none\" to clear deadline or project, and an empty string to clear description or link.",
     "inputSchema": ["type": "object", "required": ["id"], "properties": [
        "id": ["type": "string", "description": "Task id from list_tasks, or a unique part of its title."],
        "title": ["type": "string"], "description": ["type": "string"], "link": ["type": "string"],
        "due": ["type": "string", "description": dueDesc + " Use \"none\" to remove."],
        "project": ["type": "string", "description": "Project name, or \"none\"."],
        "status": status]]],
    ["name": "move_task",
     "description": "Move a task between columns: todo (To Do), doing (Doing, shown as high priority in Reminders) or done (completed).",
     "inputSchema": ["type": "object", "required": ["id", "status"], "properties": [
        "id": ["type": "string", "description": "Task id or a unique part of its title."], "status": status]]],
    ["name": "complete_task",
     "description": "Mark a task as done.",
     "inputSchema": ["type": "object", "required": ["id"], "properties": [
        "id": ["type": "string", "description": "Task id or a unique part of its title."]]]],
  ]
}

func callTool(_ name: String, _ a: [String: Any]) throws -> String {
  try ensureAccess()
  store.refreshSourcesIfNecessary()
  var data = KData.load()
  func str(_ k: String) -> String? { (a[k] as? String).map { $0.trimmingCharacters(in: .whitespaces) } }

  switch name {
  case "list_tasks":
    let st = str("status")?.lowercased() ?? "open"
    var pool: [EKReminder] = []
    if st != "done" { pool += openReminders() }
    if st == "done" || st == "all" { pool += recentDone() }
    if ["todo", "doing"].contains(st) { pool = pool.filter { status($0) == st } }
    if let p = str("project"), !p.isEmpty {
      let n = p.lowercased()
      pool = pool.filter { r in
        guard let k = data.projectKey(for: r) else { return false }
        return k.lowercased() == n || (data.label(k) ?? "").lowercased() == n
      }
    }
    if let q = str("query")?.lowercased(), !q.isEmpty {
      pool = pool.filter { ($0.title ?? "").lowercased().contains(q) || ($0.notes ?? "").lowercased().contains(q) }
    }
    if let due = str("due")?.lowercased() {
      let now = Date(), cal = Calendar.current
      pool = pool.filter { r in
        guard let d = dueDate(r) else { return false }
        switch due {
        case "overdue": return isOverdue(r)
        case "today": return cal.isDateInToday(d)
        case "week": return d < now.addingTimeInterval(7 * 86400)
        default: return true
        }
      }
    }
    let idx = Dictionary(data.order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
    let rank = ["doing": 0, "todo": 1, "done": 2]
    pool.sort { a, b in
      let sa = rank[status(a)]!, sb = rank[status(b)]!
      if sa != sb { return sa < sb }
      return (idx[a.calendarItemIdentifier] ?? Int.max) < (idx[b.calendarItemIdentifier] ?? Int.max)
    }
    if pool.isEmpty { return "No matching tasks." }
    return "\(pool.count) task\(pool.count == 1 ? "" : "s"):\n" + pool.map { describe($0, data) }.joined(separator: "\n")

  case "add_task":
    guard let title = str("title"), !title.isEmpty else { throw KError("title is required.") }
    var f: [String: Any] = [:]
    if let v = a["description"] as? String { f["notes"] = v }
    if let v = a["link"] as? String { f["url"] = v }
    if let v = a["due"] as? String, !v.isEmpty { f["due"] = v }
    if let v = a["status"] as? String { f["status"] = v }
    if let v = a["project"] as? String, !v.isEmpty { f["project"] = v }
    let r = try createTask(title: title, fields: f, data: &data)
    data.save()
    return "Added:\n" + describe(r, data)

  case "update_task":
    guard let ref = str("id") else { throw KError("id is required.") }
    let r = try resolve(ref)
    var f: [String: Any] = [:]
    for k in ["title", "description", "link", "due", "project", "status"] { if let v = a[k] as? String { f[k] = v } }
    if f.isEmpty { throw KError("Nothing to change. Pass at least one of title, description, link, due, project, status.") }
    let changed = try applyUpdate(r, f, &data)
    try save(r); data.save()
    return "Updated \(changed.joined(separator: ", ")):\n" + describe(r, data)

  case "move_task", "complete_task":
    guard let ref = str("id") else { throw KError("id is required.") }
    let r = try resolve(ref)
    try setStatus(r, name == "complete_task" ? "done" : (str("status") ?? ""))
    try save(r)
    return "Moved to \(statusLabel[status(r)]!):\n" + describe(r, data)

  default:
    throw KError("Unknown tool \(name).")
  }
}

func mcpServe() {
  setvbuf(stdout, nil, _IONBF, 0)
  func send(_ obj: [String: Any]) { out(json(obj)) }
  let instructions = """
    Tools for the user's desktop Kanban board, which is backed by Apple Reminders. \
    Columns: To Do, Doing, Done. Changes show up on their Mac desktop widget within seconds and on their iPhone. \
    When adding tasks, keep titles short and put details in description; set due when a time is mentioned. \
    There is deliberately no delete tool: ask the user to delete tasks in the widget.
    """
  while let line = readLine(strippingNewline: true) {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty,
          let msg = parseJSON(line) as? [String: Any] else { continue }
    guard let id = msg["id"] else { continue }          // notifications need no reply
    let method = msg["method"] as? String ?? ""
    let params = msg["params"] as? [String: Any] ?? [:]
    switch method {
    case "initialize":
      let asked = params["protocolVersion"] as? String ?? ""
      let known = ["2024-11-05", "2025-03-26", "2025-06-18"]
      send(["jsonrpc": "2.0", "id": id, "result": [
        "protocolVersion": known.contains(asked) ? asked : "2025-06-18",
        "capabilities": ["tools": ["listChanged": false]],
        "serverInfo": ["name": "reminders-kanban", "title": "Reminders Kanban", "version": VERSION],
        "instructions": instructions]])
    case "ping":
      send(["jsonrpc": "2.0", "id": id, "result": [String: Any]()])
    case "tools/list":
      send(["jsonrpc": "2.0", "id": id, "result": ["tools": toolDefs(KData.load())]])
    case "tools/call":
      let name = params["name"] as? String ?? ""
      let args = params["arguments"] as? [String: Any] ?? [:]
      do {
        let text = try callTool(name, args)
        send(["jsonrpc": "2.0", "id": id, "result": ["content": [["type": "text", "text": text]], "isError": false]])
      } catch {
        send(["jsonrpc": "2.0", "id": id, "result": ["content": [["type": "text", "text": "Error: \(error)"]], "isError": true]])
      }
    default:
      send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found: \(method)"]])
    }
  }
}

// MARK: - doctor

func doctor() -> Int32 {
  var ok = true
  func line(_ good: Bool, _ s: String, _ fix: String = "", required: Bool = true) {
    out("\(good ? "✓" : (required ? "✗" : "–")) \(s)" + (good || fix.isEmpty ? "" : "\n    → \(fix)"))
    if !good && required { ok = false }
  }
  out("Reminders Kanban \(VERSION)")
  var access = hasAccess()
  if !access { access = (try? ensureAccess()) != nil }
  line(access, "Reminders access", "Allow it in System Settings → Privacy & Security → Reminders, then run doctor again.")
  if access {
    let n = openReminders().count
    out("    \(n) open task\(n == 1 ? "" : "s")")
  }
  let fm = FileManager.default
  line(fm.fileExists(atPath: "/Applications/Übersicht.app"), "Übersicht installed", "brew install --cask ubersicht")
  line(fm.fileExists(atPath: widgetDir.appendingPathComponent("index.jsx").path), "Widget installed", "Run install.sh")
  let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep"); p.arguments = ["-x", "Übersicht"]
  p.standardOutput = FileHandle.nullDevice; try? p.run(); p.waitUntilExit()
  line(p.terminationStatus == 0, "Übersicht running", "open -a Übersicht")
  func has(_ path: String) -> Bool {
    ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").contains("reminders-kanban")
  }
  line(has(home.appendingPathComponent("Library/Application Support/Claude/claude_desktop_config.json").path),
       "Connected to Claude Desktop", "install.sh --claude-desktop (then restart Claude)", required: false)
  line(has(home.appendingPathComponent(".claude.json").path), "Connected to Claude Code", "install.sh --claude-code", required: false)
  line(has(home.appendingPathComponent(".codex/config.toml").path), "Connected to Codex / ChatGPT desktop", "install.sh --codex", required: false)
  out(ok ? "All good." : "Some checks failed (see → above).")
  return ok ? 0 : 1
}

// MARK: - CLI

let args = Array(CommandLine.arguments.dropFirst())
let cmd = args.first ?? "list"
func arg(_ i: Int) -> String { args.count > i ? args[i] : "" }
func rest(_ i: Int) -> String { args.dropFirst(i).joined(separator: " ") }

switch cmd {
case "mcp": mcpServe(); exit(0)
case "doctor": exit(doctor())
case "version", "--version", "-v": out(VERSION); exit(0)
default: break
}

do {
  try ensureAccess()
  var data = KData.load()
  switch cmd {
  case "list":
    if !data.linksInNotes { migrateLinks(openReminders() + recentDone()); data.linksInNotes = true; data.save() }
    let tasks = (openReminders() + recentDone()).map { taskDict($0, data) }
    out(json(["tasks": tasks, "order": data.order, "projects": data.projects.map {
      ["key": $0["key"] ?? "", "label": $0["label"] ?? "", "color": $0["color"] ?? "#98989D"] }, "fresh": data.fresh]))

  case "move":
    let r = try resolve(arg(1)); try setStatus(r, arg(2)); try save(r); out("ok")

  case "add":
    let (title, due, doing) = smartParse(rest(1))
    guard !title.isEmpty else { throw KError("empty") }
    var f: [String: Any] = [:]
    if let w = due { f["due"] = w.allDay ? dayOnly.string(from: w.date) : iso.string(from: w.date) }
    if doing { f["status"] = "doing" }
    let r = try createTask(title: title, fields: f, data: &data)
    data.save(); out(r.calendarItemIdentifier)

  case "update":
    guard let f = parseJSON(rest(2)) as? [String: Any] else { throw KError("update needs a JSON object") }
    let r = try resolve(arg(1)); try applyUpdate(r, f, &data); try save(r); data.save(); out("ok")

  case "project":
    let r = try resolve(arg(1)); try applyUpdate(r, ["project": arg(2)], &data); data.save(); out("ok")

  case "order":
    guard let ids = parseJSON(rest(1)) as? [String] else { throw KError("order needs a JSON array") }
    let live = Set((openReminders() + recentDone()).map { $0.calendarItemIdentifier })
    data.order = ids.filter { live.contains($0) }; data.save(); out("ok")

  case "import":
    guard let obj = parseJSON(rest(1)) as? [String: Any] else { throw KError("import needs JSON") }
    if data.fresh {
      data.order = obj["order"] as? [String] ?? []
      data.assign = obj["assign"] as? [String: String] ?? [:]
      data.save(); out("imported")
    } else { out("skipped") }

  case "delete":
    let r = try resolve(arg(1))
    do { try store.remove(r, commit: true) } catch { throw KError("Couldn't delete: \(error.localizedDescription)") }
    data.order.removeAll { $0 == r.calendarItemIdentifier }; data.assign.removeValue(forKey: r.calendarItemIdentifier)
    data.save(); out("ok")

  default: throw KError("Unknown command \(cmd). Commands: list add move update project order delete doctor mcp version")
  }
} catch {
  fail("\(error)")
}
