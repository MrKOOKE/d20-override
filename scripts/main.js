/* globals game, Hooks, Dialog, ui */

const MODULE_ID = "d20-override";
const SETTING_KEY = "nextD20";
// Hidden per-die option key used to mark a specific d20 for forcing
const FORCE_OPT = "d20OverrideForced";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_KEY, {
    name: "Next D20 Value",
    hint: "If set (1-20), the next d20 roll will be forced to this value, then the setting resets to 0.",
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
});

// Patch the core Die evaluation so a marked d20 die produces the exact requested face value.
// This ensures the visual die result and total match, with no grey/modified indicators.
Hooks.once("ready", () => {
  try {
    const Die = foundry?.dice?.terms?.Die;
    if (!Die) return;
    if (Die.prototype?.__d20OverridePatched) return;

    function clearForced(term) {
      const forced = Number(term?.options?.[FORCE_OPT]);
      if (!Number.isFinite(forced)) return;
      try { delete term.options[FORCE_OPT]; } catch {}
    }

    // Wrap evaluate (async)
    const originalEvaluate = Die.prototype.evaluate;
    if (typeof originalEvaluate === "function") {
      Die.prototype.evaluate = function(options = {}) {
        // Force the value BEFORE evaluation so визуальный бросок показывает нужное число
        try {
          const forced = Number(this?.options?.[FORCE_OPT]);
          if ((this instanceof CONFIG.Dice.D20Die) && Number.isFinite(forced)) {
            const faces = Number(this?.faces) || 20;
            const clamped = Math.max(1, Math.min(faces, Math.floor(forced)));
            // Прописываем ожидаемые результаты заранее, чтобы renderer их использовал
            this.results = Array.from({ length: this.number || 1 }, () => ({ result: clamped, active: true }));
          }
        } catch {}
        const out = originalEvaluate.call(this, options);
        try { if (this instanceof CONFIG.Dice.D20Die) clearForced(this); } catch {}
        return out;
      };
    }

    // Wrap evaluateSync
    const originalEvaluateSync = Die.prototype.evaluateSync;
    if (typeof originalEvaluateSync === "function") {
      Die.prototype.evaluateSync = function(options = {}) {
        try {
          const forced = Number(this?.options?.[FORCE_OPT]);
          if ((this instanceof CONFIG.Dice.D20Die) && Number.isFinite(forced)) {
            const faces = Number(this?.faces) || 20;
            const clamped = Math.max(1, Math.min(faces, Math.floor(forced)));
            this.results = Array.from({ length: this.number || 1 }, () => ({ result: clamped, active: true }));
          }
        } catch {}
        const out = originalEvaluateSync.call(this, options);
        try { if (this instanceof CONFIG.Dice.D20Die) clearForced(this); } catch {}
        return out;
      };
    }

    // Also wrap low-level roll in case some workflows call it directly.
    // Here we actually enforce the value so both dice (advantage/disadvantage) match and the kept result equals
    // the requested number.
    const originalRoll = Die.prototype.roll;
    if (typeof originalRoll === "function") {
      Die.prototype.roll = function(options = {}) {
        const forced = Number(this?.options?.[FORCE_OPT]);
        if ((this instanceof CONFIG.Dice.D20Die) && Number.isFinite(forced)) {
          const faces = Number(this?.faces) || 20;
          const clamped = Math.max(1, Math.min(faces, Math.floor(forced)));
          return clamped;
        }
        return originalRoll.call(this, options);
      };
    }

    Object.defineProperty(Die.prototype, "__d20OverridePatched", { value: true, writable: false });
  } catch (err) {
    console.error(`${MODULE_ID} | Failed to patch d20 evaluation`, err);
  }
});

function isD20RollConfig(config) {
  try {
    return Array.isArray(config?.rolls);
  } catch (e) {
    return false;
  }
}

/**
 * Remove min/max modifiers (e.g. min20, max20, mi20, ma20) from a roll formula string.
 * Keeps the rest of the formula intact so the chat card does not reveal the override.
 * @param {string} formulaText
 * @returns {string}
 */
function sanitizeRollFormulaString(formulaText) {
  if (typeof formulaText !== "string") return formulaText;

  // Remove tokens like: min20, max20, mi20, ma20 (with or without spaces, even when glued to previous tokens)
  let sanitized = formulaText.replace(/(mi?n|ma?x)\s*\d+/gi, "");

  // Collapse multiple spaces and redundant operators, and clean up artifacts like '1d20  + 0'
  sanitized = sanitized
    .replace(/\s{2,}/g, " ")
    .replace(/\+\s*\+/g, "+")
    .replace(/^\s*\+\s*/, "")
    .replace(/\s*\+\s*$/, "")
    .replace(/\s*([+\-*/()])\s*/g, " $1 ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return sanitized || "";
}

async function promptForNextD20() {
  const content = `<div class="form-group">\n    <label>Значение на к20 (1-20):</label>\n    <input type="number" name="value" min="1" max="20" value="${game.settings.get(MODULE_ID, SETTING_KEY) || 0}" />\n    <p class="notes">0 или пусто — сброс, без подмены.</p>\n  </div>`;

  return new Promise(resolve => {
    new Dialog({
      title: "Выбрать следующее значение к20",
      content,
      buttons: {
        ok: {
          icon: '<i class="fas fa-check"></i>',
          label: "Применить",
          callback: html => {
            const raw = Number(html.find('input[name="value"]').val());
            const val = Number.isFinite(raw) ? raw : 0;
            const clamped = (val >= 1 && val <= 20) ? val : 0;
            game.settings.set(MODULE_ID, SETTING_KEY, clamped);
            resolve(clamped);
          }
        },
        reset: {
          icon: '<i class="fas fa-undo"></i>',
          label: "Сброс",
          callback: () => {
            game.settings.set(MODULE_ID, SETTING_KEY, 0);
            resolve(0);
          }
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Отмена", callback: () => resolve(null) }
      },
      default: "ok"
    }).render(true);
  });
}

// Add a tool to the Token controls (left sidebar) similar to Stealth button implementation
Hooks.on("getSceneControlButtons", (controls) => {
  try {
    const tokenControl = controls.find((c) => c.name === "token");
    if (!tokenControl) return;

    // Prevent duplicates
    if (tokenControl.tools.some((t) => t.name === "d20-override-tool")) return;

    const current = game.settings.get(MODULE_ID, SETTING_KEY) || 0;

    tokenControl.tools.push({
      name: "d20-override-tool",
      title: current ? `Подмена к20: ${current}` : "Подмена к20",
      icon: "fas fa-dice-d20",
      visible: !!game.user?.isGM,
      button: true,
      onClick: async () => {
        await promptForNextD20();
        // Re-render controls to refresh tooltip with the latest value
        setTimeout(() => ui.controls?.render(), 50);
      },
    });
  } catch (err) {
    console.error(`${MODULE_ID} | Error adding scene control button`, err);
  }
});

function applyNextD20Override(rolls, config) {
  try {
    const next = game.settings.get(MODULE_ID, SETTING_KEY) || 0;
    if (!next) return;
    const valid = Array.isArray(rolls) && rolls.length && isD20RollConfig(config);
    if (!valid) return;

    for (const roll of rolls) {
      if (!roll?.validD20Roll) continue;
      const d20 = roll.d20;
      if (!d20) continue;

      // Match the number of dice to the current advantage mode so все кубы получают нужное значение
      const advMode = Number(d20?.options?.advantageMode ?? roll?.options?.advantageMode ?? 0);
      if (advMode === (CONFIG.Dice?.D20Roll?.ADV_MODE?.ADVANTAGE ?? 1)) d20.number = (d20.options?.elvenAccuracy ? 3 : 2);
      else if (advMode === (CONFIG.Dice?.D20Roll?.ADV_MODE?.DISADVANTAGE ?? -1)) d20.number = 2;
      else d20.number = 1;

      d20.options[FORCE_OPT] = next;
      try { roll.options = roll.options || {}; roll.options[`${MODULE_ID}Forced`] = next; } catch {}
    }

    // Reset after applying
    game.settings.set(MODULE_ID, SETTING_KEY, 0);
    try { setTimeout(() => ui.controls?.render(), 50); } catch {}
  } catch (err) {
    console.error(`${MODULE_ID} | Error applying d20 override`, err);
  }
}

// Apply once to the next d20-based roll: generic hook used by все d20 тесты
Hooks.on("dnd5e.postD20TestRollConfiguration", applyNextD20Override);
// Back-compat for некоторые места (например, скилл-чеки в ранних версиях):
Hooks.on("dnd5e.postRollConfiguration", applyNextD20Override);

// No chat formula sanitization is needed anymore since we no longer inject min/max tokens.
