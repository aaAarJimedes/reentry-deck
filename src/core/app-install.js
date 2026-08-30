export const APP_INSTALL_STATUS = Object.freeze({
  UNAVAILABLE: "unavailable",
  AVAILABLE: "available",
  PROMPTING: "prompting",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
  INSTALLED: "installed",
  ERROR: "error"
});

export function createAppInstallController({ installed = false } = {}) {
  let status = installed ? APP_INSTALL_STATUS.INSTALLED : APP_INSTALL_STATUS.UNAVAILABLE;
  let promptEvent = null;
  let generation = 0;
  let destroyed = false;

  const result = (outcome = null) => Object.freeze({ outcome, status });

  return Object.freeze({
    getStatus() {
      return status;
    },

    capture(event) {
      if (destroyed
        || status === APP_INSTALL_STATUS.INSTALLED
        || event?.isTrusted !== true
        || typeof event.preventDefault !== "function"
        || typeof event.prompt !== "function") {
        return false;
      }
      event.preventDefault();
      promptEvent = event;
      generation += 1;
      status = APP_INSTALL_STATUS.AVAILABLE;
      return true;
    },

    async prompt() {
      if (destroyed || status !== APP_INSTALL_STATUS.AVAILABLE || !promptEvent) return result();

      const event = promptEvent;
      promptEvent = null;
      const request = ++generation;
      status = APP_INSTALL_STATUS.PROMPTING;

      try {
        const promptResult = event.prompt();
        const choiceResult = event.userChoice;
        const [, choice] = await Promise.all([promptResult, choiceResult]);
        if (destroyed || request !== generation) return result();
        if (choice?.outcome !== "accepted" && choice?.outcome !== "dismissed") {
          throw new Error("浏览器安装提示没有返回有效选择。");
        }
        status = choice.outcome === "accepted"
          ? APP_INSTALL_STATUS.ACCEPTED
          : APP_INSTALL_STATUS.DISMISSED;
        return result(choice.outcome);
      } catch (error) {
        if (destroyed || request !== generation) return result();
        status = APP_INSTALL_STATUS.ERROR;
        throw error;
      }
    },

    markInstalled() {
      if (destroyed) return false;
      const changed = status !== APP_INSTALL_STATUS.INSTALLED;
      promptEvent = null;
      generation += 1;
      status = APP_INSTALL_STATUS.INSTALLED;
      return changed;
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      promptEvent = null;
      generation += 1;
    }
  });
}
