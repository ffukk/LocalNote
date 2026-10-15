import { newId } from "./tasks.js";
import { addDays, toDateISO } from "./time.js";

/** 首次启动写入少量示例数据，便于立刻看到列表/报表/提醒的效果。 */
export function seedIfEmpty(data, now = new Date()) {
  if (data.seeded || data.tasks.length || data.projects.length) return false;
  data.seeded = true;

  const today = toDateISO(now);
  const projects = [
    { id: newId("p"), name: "工作", color: "#2f6fed", createdAt: now.toISOString() },
    { id: newId("p"), name: "学习", color: "#7c4dff", createdAt: now.toISOString() },
    { id: newId("p"), name: "生活", color: "#12a67b", createdAt: now.toISOString() },
  ];
  data.projects = projects;

  const base = (overrides) => ({
    id: newId("t"),
    title: "",
    notes: "",
    priority: "P2",
    status: "todo",
    due: null,
    dueTime: null,
    remindMinutes: null,
    tags: [],
    projectId: null,
    parentId: null,
    repeat: { rule: "none" },
    reminderDismissedAt: null,
    snoozedUntil: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    order: now.getTime(),
    ...overrides,
  });

  const weekly = base({
    title: "写本周工作周报",
    notes: "重复任务示例：勾选完成后自动生成下一次。",
    priority: "P1",
    projectId: projects[0].id,
    tags: ["例行"],
    due: today,
    dueTime: "18:00",
    remindMinutes: 60,
    repeat: { rule: "weekly", weekdays: [5] },
  });

  const release = base({
    title: "整理任务管理系统需求",
    projectId: projects[0].id,
    priority: "P1",
    tags: ["项目"],
    due: addDays(today, -2),
    remindMinutes: 0,
    notes: "逾期示例：会出现在顶部提醒与回顾的逾期清单里。",
  });

  const subA = base({ title: "列出功能清单", projectId: projects[0].id, parentId: release.id, priority: "P3", order: now.getTime() + 1 });
  const subB = base({
    title: "确认数据存储方式",
    parentId: release.id,
    projectId: projects[0].id,
    priority: "P2",
    order: now.getTime() + 2,
    status: "done",
    completedAt: new Date(now.getTime() - 86_400_000).toISOString(),
  });

  const study = base({
    title: "读完《深度工作》第 3 章",
    projectId: projects[1].id,
    priority: "P3",
    tags: ["阅读"],
    due: addDays(today, 3),
    remindMinutes: 30,
  });

  const life = base({
    title: "预约牙科检查",
    projectId: projects[2].id,
    priority: "P2",
    due: addDays(today, 7),
    repeat: { rule: "interval", intervalDays: 180 },
  });

  const doneSample1 = base({
    title: "备份本地数据",
    projectId: projects[2].id,
    priority: "P4",
    status: "done",
    completedAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    createdAt: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
  });
  const doneSample2 = base({
    title: "搭建本地任务管理系统 v1",
    projectId: projects[0].id,
    priority: "P1",
    tags: ["里程碑"],
    status: "done",
    completedAt: new Date(now.getTime() - 86_400_000).toISOString(),
    createdAt: new Date(now.getTime() - 4 * 86_400_000).toISOString(),
  });

  data.tasks = [weekly, release, subA, subB, study, life, doneSample1, doneSample2];
  return true;
}
