import { CRUMB_TYPES, createCrumb } from "./model.js";

export function prepareQuickCapture(state, input, now = Date.now()) {
  const project = state?.projects?.find((item) => item.id === input?.projectId && item.status !== "archived");
  if (!project) throw new Error("目标项目不可用。 ");
  if (!CRUMB_TYPES.includes(input?.type)) throw new Error("记录类型不可用。 ");
  const session = state.sessions.find((item) => item.projectId === project.id && item.status === "active") ?? null;
  const crumb = createCrumb({
    projectId: project.id,
    sessionId: session?.id ?? null,
    type: input.type,
    text: input.text,
    pinned: input.pinned === true || input.pinned === "on"
  }, now);
  if (!crumb.text) throw new Error("先写下一条记录。 ");

  return {
    crumb,
    projectTitle: project.title,
    linkedToActiveSession: Boolean(session)
  };
}
