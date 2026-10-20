const MAX_CONTROLLED_UNITS = 3;
const DEFAULT_UNIT_EN = 160;

const state = {
  sessionId: localStorage.getItem("rb_session") || "",
  user: null,
  view: "auth",
  currentRoomId: "",
  room: null,
  rooms: [],
  data: null,
  databaseTab: "units",
  pollTimer: null,
  selectedUnitId: localStorage.getItem("rb_selected_unit") || "",
  selectedPilotId: localStorage.getItem("rb_selected_pilot") || "",
  selectedMapId: localStorage.getItem("rb_selected_map") || "001",
  aiSimulationMapId: localStorage.getItem("rb_ai_sim_map") || "002",
  deckRemovalDraft: { roomId: "", unitId: "", keys: [] },
  battleDraft: { roomId: "", round: 0, actions: [], reserveKeys: [] },
  activeBattleTurn: 0,
  selectedBattleCoord: null,
  battleMapZoom: 0.62,
  battleMapDrag: null,
  battleMapPanMoved: false,
  battleHandScroll: [],
  deckPreviewScroll: [],
  battleSlotScroll: null,
  selectedBattleHandActor: "",
  resolutionPlayback: { key: "", index: 0, timer: null, skipped: false },
  resolutionCenteredKey: "",
  respawnAnimationKey: "",
  lastSelfCombatSnapshot: null,
  detailKey: "",
  detailKeyBound: false,
  pointer: { x: 0, y: 0 },
  aiSimulationResult: null,
  aiSimulationDraft: {},
  showNewbieGuide: false,
};

const app = document.querySelector("#app");
const DEFAULT_AI_PILOT_ID = "099";
const DEFAULT_AI_MAP_ID = "002";
const FALLBACK_CARD_IMAGE = "/assets/ui/empty_card_slot.png";
const RESOLUTION_CUE_MS = 1500;
const RESOLUTION_ANIM_MS = 1700;
const sfxState = {
  context: null,
  master: null,
  noiseBuffer: null,
  bound: false,
};

function aiSimulationDraftValue(name, fallback = "") {
  return state.aiSimulationDraft?.[name] ?? fallback;
}

function captureAiSimulationDraft(form) {
  state.aiSimulationDraft = Object.fromEntries(Array.from(form.entries()).map(([key, value]) => [key, String(value || "")]));
}

function bindSfxUnlock() {
  if (sfxState.bound) return;
  sfxState.bound = true;
  const unlock = () => resumeSfxContext();
  document.addEventListener("pointerdown", unlock, { passive: true });
  document.addEventListener("keydown", unlock);
  document.addEventListener("touchstart", unlock, { passive: true });
}

function getSfxContext() {
  if (typeof window === "undefined") return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!sfxState.context) {
    const context = new AudioContextClass();
    const master = context.createGain();
    master.gain.value = 0.16;
    master.connect(context.destination);
    sfxState.context = context;
    sfxState.master = master;
  }
  return sfxState.context;
}

function resumeSfxContext() {
  const context = getSfxContext();
  if (!context || context.state !== "suspended") return;
  context.resume().catch(() => {});
}

function sfxTime(delayMs = 0) {
  const context = getSfxContext();
  if (!context) return null;
  if (context.state === "suspended") context.resume().catch(() => {});
  return context.currentTime + Math.max(0, Number(delayMs || 0)) / 1000;
}

function sfxEnvelope(context, time, duration, volume = 0.22, attack = 0.006, release = 0.04) {
  const gain = context.createGain();
  const end = time + Math.max(0.02, Number(duration || 0.2));
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(Math.max(0.0001, volume), time + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, Math.max(time + attack + 0.01, end - release));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  gain.connect(sfxState.master);
  return gain;
}

function sfxTone({ delayMs = 0, duration = 0.2, frequency = 440, endFrequency = null, type = "sine", volume = 0.18 } = {}) {
  const context = getSfxContext();
  const time = sfxTime(delayMs);
  if (!context || time === null || !sfxState.master) return;
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(Math.max(20, Number(frequency || 440)), time);
  if (endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, Number(endFrequency)), time + duration);
  }
  oscillator.connect(sfxEnvelope(context, time, duration, volume));
  oscillator.start(time);
  oscillator.stop(time + duration + 0.04);
}

function getNoiseBuffer(context) {
  if (sfxState.noiseBuffer) return sfxState.noiseBuffer;
  const length = Math.floor(context.sampleRate * 1.2);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  sfxState.noiseBuffer = buffer;
  return buffer;
}

function sfxNoise({ delayMs = 0, duration = 0.18, volume = 0.16, filter = "bandpass", frequency = 1200 } = {}) {
  const context = getSfxContext();
  const time = sfxTime(delayMs);
  if (!context || time === null || !sfxState.master) return;
  const source = context.createBufferSource();
  const filterNode = context.createBiquadFilter();
  source.buffer = getNoiseBuffer(context);
  filterNode.type = filter;
  filterNode.frequency.setValueAtTime(Math.max(40, Number(frequency || 1200)), time);
  filterNode.Q.value = filter === "lowpass" ? 0.65 : 3.5;
  source.connect(filterNode);
  filterNode.connect(sfxEnvelope(context, time, duration, volume, 0.003, 0.05));
  source.start(time);
  source.stop(time + duration + 0.05);
}

function playSfx(name, options = {}) {
  const delayMs = Number(options.delayMs || 0);
  switch (name) {
    case "actor-cue":
      sfxTone({ delayMs, duration: 0.12, frequency: 740, endFrequency: 980, type: "triangle", volume: 0.055 });
      break;
    case "sword-slash":
      sfxNoise({ delayMs, duration: 0.22, volume: 0.18, filter: "highpass", frequency: 900 });
      sfxTone({ delayMs: delayMs + 80, duration: 0.16, frequency: 680, endFrequency: 210, type: "sawtooth", volume: 0.085 });
      break;
    case "axe-slash":
      sfxNoise({ delayMs, duration: 0.26, volume: 0.2, filter: "bandpass", frequency: 620 });
      sfxTone({ delayMs: delayMs + 110, duration: 0.2, frequency: 210, endFrequency: 70, type: "square", volume: 0.09 });
      break;
    case "missile":
      sfxTone({ delayMs, duration: 0.55, frequency: 150, endFrequency: 520, type: "sawtooth", volume: 0.08 });
      sfxNoise({ delayMs: delayMs + 620, duration: 0.34, volume: 0.26, filter: "lowpass", frequency: 560 });
      sfxTone({ delayMs: delayMs + 630, duration: 0.3, frequency: 92, endFrequency: 38, type: "sine", volume: 0.18 });
      break;
    case "machinegun":
      [0, 95, 190, 285, 380].forEach((offset) => {
        sfxNoise({ delayMs: delayMs + offset, duration: 0.045, volume: 0.18, filter: "bandpass", frequency: 2100 });
        sfxTone({ delayMs: delayMs + offset, duration: 0.035, frequency: 180, endFrequency: 120, type: "square", volume: 0.05 });
      });
      break;
    case "light-rifle":
      [0, 140, 280].forEach((offset) => {
        sfxTone({ delayMs: delayMs + offset, duration: 0.16, frequency: 980, endFrequency: 1620, type: "triangle", volume: 0.09 });
        sfxNoise({ delayMs: delayMs + offset, duration: 0.08, volume: 0.08, filter: "highpass", frequency: 1800 });
      });
      break;
    case "shotgun":
      sfxNoise({ delayMs, duration: 0.2, volume: 0.28, filter: "bandpass", frequency: 1100 });
      sfxTone({ delayMs, duration: 0.14, frequency: 150, endFrequency: 55, type: "square", volume: 0.12 });
      break;
    case "flame":
      sfxNoise({ delayMs, duration: 0.85, volume: 0.17, filter: "lowpass", frequency: 780 });
      sfxTone({ delayMs: delayMs + 80, duration: 0.6, frequency: 90, endFrequency: 135, type: "sawtooth", volume: 0.035 });
      break;
    case "beam":
      sfxTone({ delayMs, duration: 0.56, frequency: 180, endFrequency: 1180, type: "sawtooth", volume: 0.11 });
      sfxTone({ delayMs: delayMs + 40, duration: 0.45, frequency: 920, endFrequency: 760, type: "triangle", volume: 0.07 });
      break;
    case "explosion":
      sfxNoise({ delayMs, duration: 0.38, volume: 0.28, filter: "lowpass", frequency: 520 });
      sfxTone({ delayMs, duration: 0.34, frequency: 96, endFrequency: 34, type: "sine", volume: 0.18 });
      break;
    case "guard":
      sfxNoise({ delayMs, duration: 0.16, volume: 0.18, filter: "bandpass", frequency: 760 });
      sfxTone({ delayMs, duration: 0.36, frequency: 180, endFrequency: 110, type: "triangle", volume: 0.11 });
      break;
    case "dodge":
      sfxTone({ delayMs, duration: 0.12, frequency: 520, endFrequency: 760, type: "sine", volume: 0.075 });
      sfxTone({ delayMs: delayMs + 130, duration: 0.12, frequency: 760, endFrequency: 440, type: "sine", volume: 0.075 });
      break;
    case "shield":
      sfxTone({ delayMs, duration: 0.42, frequency: 260, endFrequency: 620, type: "triangle", volume: 0.12 });
      sfxNoise({ delayMs: delayMs + 60, duration: 0.18, volume: 0.075, filter: "highpass", frequency: 2500 });
      break;
    case "teleport":
      sfxTone({ delayMs, duration: 0.28, frequency: 760, endFrequency: 1800, type: "triangle", volume: 0.11 });
      sfxTone({ delayMs: delayMs + 260, duration: 0.32, frequency: 1800, endFrequency: 420, type: "triangle", volume: 0.12 });
      sfxNoise({ delayMs: delayMs + 245, duration: 0.12, volume: 0.08, filter: "highpass", frequency: 2200 });
      break;
    case "move":
      sfxNoise({ delayMs, duration: 0.16, volume: 0.07, filter: "bandpass", frequency: 900 });
      sfxTone({ delayMs, duration: 0.14, frequency: 180, endFrequency: 260, type: "triangle", volume: 0.045 });
      break;
    case "hit":
      sfxNoise({ delayMs, duration: 0.12, volume: 0.18, filter: "lowpass", frequency: 680 });
      sfxTone({ delayMs, duration: 0.18, frequency: 150, endFrequency: 62, type: "sine", volume: 0.12 });
      break;
    case "miss":
      sfxTone({ delayMs, duration: 0.12, frequency: 260, endFrequency: 180, type: "triangle", volume: 0.07 });
      sfxNoise({ delayMs, duration: 0.08, volume: 0.06, filter: "highpass", frequency: 1400 });
      break;
    case "spirit":
      [0, 110, 220].forEach((offset, index) => {
        sfxTone({ delayMs: delayMs + offset, duration: 0.28, frequency: [620, 820, 1240][index], type: "sine", volume: 0.065 });
      });
      break;
    case "treasure":
      [0, 90, 180].forEach((offset, index) => {
        sfxTone({ delayMs: delayMs + offset, duration: 0.16, frequency: [660, 880, 1320][index], type: "triangle", volume: 0.08 });
      });
      break;
    case "destroyed":
      sfxNoise({ delayMs, duration: 0.55, volume: 0.3, filter: "lowpass", frequency: 480 });
      sfxTone({ delayMs, duration: 0.52, frequency: 120, endFrequency: 28, type: "sawtooth", volume: 0.18 });
      break;
    default:
      break;
  }
}

function normalizeVoiceAsset(path) {
  if (!path) return "";
  const normalized = String(path).replaceAll("\\", "/").replace(/^\/+/, "");
  if (normalized.startsWith("assets/voice/")) return `/${normalized}`;
  if (normalized.startsWith("voice/")) return `/assets/${normalized}`;
  return `/assets/voice/${normalized}`;
}

function playVoiceFile(path, options = {}) {
  const src = normalizeVoiceAsset(path);
  if (!src) return false;
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const start = () => {
    const audio = new Audio(src);
    audio.volume = Math.max(0, Math.min(1, Number(options.volume ?? 0.78)));
    audio.addEventListener("error", () => {
      if (options.fallback) playSfx(options.fallback);
    }, { once: true });
    audio.play().catch(() => {
      if (options.fallback) playSfx(options.fallback);
    });
  };
  if (delayMs) {
    setTimeout(start, delayMs);
  } else {
    start();
  }
  return true;
}

function playCardVoice(path, fallback, options = {}) {
  if (path) {
    const played = playVoiceFile(path, { ...options, fallback });
    if (fallback && options.layerFallback) playSfx(fallback, options);
    return played;
  }
  if (fallback) playSfx(fallback, options);
  return false;
}

function normalizeAsset(path) {
  if (!path) return "";
  const normalized = String(path).replaceAll("\\", "/");
  if (normalized.startsWith("assets/")) return `/${normalized}`;
  if (normalized.startsWith("/assets/")) return normalized;
  return `/assets/${normalized}`;
}

function cardImageAsset(path) {
  return normalizeAsset(path) || FALLBACK_CARD_IMAGE;
}

function bindCardImageFallback() {
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      if (!img.src.includes("/assets/card_images/")) return;
      if (img.dataset.fallbackApplied) return;
      img.dataset.fallbackApplied = "true";
      img.src = FALLBACK_CARD_IMAGE;
    },
    true
  );
}

function normalizeMapImage(path) {
  if (!path) return "/assets/maps/map_001_terrain_light.png";
  const normalized = String(path).replaceAll("\\", "/");
  if (normalized.startsWith("assets/maps/")) return `/${normalized}`;
  if (normalized.startsWith("/assets/maps/")) return normalized;
  if (normalized.startsWith("map_images/")) return `/assets/maps/${normalized.split("/").pop()}`;
  if (normalized.startsWith("public/assets/maps/")) return `/${normalized.replace(/^public\//, "")}`;
  return normalizeAsset(normalized);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function setStatus(id, message, type = "") {
  const el = document.querySelector(`#${id}`);
  if (!el) return;
  el.className = `status ${type}`;
  el.textContent = message || "";
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function startRoomPolling() {
  stopPolling();
  if (!state.currentRoomId) return;
  state.pollTimer = setInterval(() => refreshRoom(false), 1400);
}

async function boot() {
  bindSfxUnlock();
  bindCardImageFallback();
  await loadGameData();
  ensureDefaultSelection();
  if (state.sessionId) {
    try {
      const result = await api("/api/session", {
        method: "POST",
        body: { sessionId: state.sessionId },
      });
      state.user = result.user;
      state.view = "lobby";
      await refreshRooms();
    } catch {
      localStorage.removeItem("rb_session");
      state.sessionId = "";
    }
  }
  render();
}

async function loadGameData() {
  const response = await fetch("/data/game-data.json", { cache: "no-store" });
  state.data = await response.json();
}

function getUnits() {
  return state.data?.["unit_data.xlsx"]?.Units || [];
}

function isPlayableUnit(unit) {
  return Boolean(
    unit?.unit_ID &&
      unit.unit_name &&
      unit.appearance &&
      unit.icon &&
      unit.max_HP &&
      unit.armor &&
      (unit.attack_cards || unit.defense_cards || unit.utility_cards)
  );
}

function unitMaxEn(unit) {
  return Number(unit?.max_EN || DEFAULT_UNIT_EN);
}

function getPlayableUnits() {
  return getUnits().filter(isPlayableUnit);
}

function getPilots() {
  return state.data?.["pilot_data.xlsx"]?.Pilot || [];
}

function getAttackCards() {
  return state.data?.["unit_data.xlsx"]?.Attack_card_list || [];
}

function getDefenseCards() {
  return state.data?.["unit_data.xlsx"]?.Defense_card_list || [];
}

function getUtilityCards() {
  return state.data?.["unit_data.xlsx"]?.Utility_card_list || [];
}

function getSpirits() {
  return state.data?.["pilot_data.xlsx"]?.Spirit_list || [];
}

function getMaps() {
  const workbook = state.data?.["map_data.xlsx"] || {};
  return Object.entries(workbook)
    .map(([sheetName, rows]) => {
      const map = { sheetName };
      for (const row of rows || []) {
        const key = row.fields || row.field || row.key || row.map_ID;
        const value = row["description/value"] ?? row.value ?? row.description ?? "";
        if (key) map[String(key)] = value;
      }
      map.map_ID = String(map.map_ID || map.id || sheetName).padStart(3, "0");
      map.name = map.name || sheetName;
      map.map_description = map.map_description || map.description || "";
      map.task_description = map.task_description || "";
      map.terrain_light_image = map.terrain_light_image || "map_images/map_001_terrain_light.png";
      map.terrain_dark_image = map.terrain_dark_image || "map_images/map_001_terrain_dark.png";
      return map;
    })
    .filter((map) => map.map_ID);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function findMap(id = getCurrentMapId()) {
  const maps = getMaps();
  return maps.find((map) => String(map.map_ID) === String(id)) || maps[0] || null;
}

function currentTeamMaxPlayers() {
  const map = findMap(state.room?.mapId || state.selectedMapId);
  return {
    "Team I": Math.max(1, Number(state.room?.teamMaxPlayers?.["Team I"] ?? map?.Team_I_max_player ?? 6) || 6),
    "Team II": Math.max(1, Number(state.room?.teamMaxPlayers?.["Team II"] ?? map?.Team_II_max_player ?? 6) || 6),
  };
}

function getCurrentMapId() {
  return state.room?.mapId || state.selectedMapId || "001";
}

function ensureDefaultSelection() {
  const units = getPlayableUnits();
  const pilots = getPilots();
  const maps = getMaps();
  if (!state.selectedUnitId && units[0]) state.selectedUnitId = String(units[0].unit_ID);
  if (!state.selectedPilotId && pilots[0]) state.selectedPilotId = String(pilots[0].pilot_ID);
  if (!state.selectedMapId && maps[0]) state.selectedMapId = String(maps[0].map_ID);
}

function findUnit(id = state.selectedUnitId) {
  const units = getPlayableUnits();
  return units.find((unit) => String(unit.unit_ID) === String(id)) || units[0] || null;
}

function findPilot(id = state.selectedPilotId) {
  return getPilots().find((pilot) => String(pilot.pilot_ID) === String(id)) || getPilots()[0] || null;
}

function getPilotSpirits(pilotId) {
  const pilot = findPilot(pilotId);
  const ids = String(pilot?.spirits || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return ids.map((id) => getSpirits().find((spirit) => String(spirit.spirit_ID) === String(id))).filter(Boolean);
}

function idList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPilotTalents(pilotId) {
  const pilot = findPilot(pilotId);
  const talents = state.data?.["pilot_data.xlsx"]?.Talent_list || [];
  return idList(pilot?.talents).map((id) => talents.find((talent) => String(talent.talent_ID) === String(id))).filter(Boolean);
}

function getUnitFeatures(unitId) {
  const unit = findUnit(unitId);
  const features = state.data?.["unit_data.xlsx"]?.Feature_list || [];
  return idList(unit?.features).map((id) => features.find((feature) => String(feature.feature_ID) === String(id))).filter(Boolean);
}

function battleSpiritCost(spiritId) {
  if (!spiritId) return 0;
  const spirit = getSpirits().find((item) => String(item.spirit_ID) === String(spiritId));
  return Number(spirit?.SP_cost || 0);
}

function battleActionSpiritCost(action) {
  return battleSpiritCost(action?.preSpiritId) + battleSpiritCost(action?.postSpiritId);
}

function spiritTargetMode(spiritId) {
  const id = String(spiritId || "").padStart(3, "0");
  if (["005", "006", "007", "008", "009", "014"].includes(id)) return "ally";
  if (id === "013") return "enemy";
  return "";
}

function spiritTargetOptions(spiritId, caster = findBattleSelf()) {
  const mode = spiritTargetMode(spiritId);
  if (!mode || !caster) return [];
  return asArray(state.room?.battle?.players).filter((player) => {
    if (player.combat?.alive === false) return false;
    return mode === "ally" ? player.team === caster.team : player.team !== caster.team;
  });
}

function battlePlayerOptionLabel(player) {
  const pilot = findPilot(player?.selectedPilotId);
  const unit = findUnit(player?.selectedUnitId);
  const pilotName = pilot?.pilot_name || pilot?.name || "驾驶员";
  const unitName = unit?.unit_name || unit?.name || "机甲";
  return `${player?.team || "-"} · ${pilotName} · ${unitName}`;
}

function defaultSpiritTargetUsername(spiritId, current = "", caster = findBattleSelf()) {
  if (current && spiritTargetOptions(spiritId, caster).some((player) => player.username === current)) return current;
  const options = spiritTargetOptions(spiritId, caster);
  if (spiritTargetMode(spiritId) === "ally" && caster && options.some((player) => player.username === caster.username)) return caster.username;
  return options[0]?.username || "";
}

function parseCardRefs(value) {
  return String(value || "")
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawId, count = "1"] = part.split(/[＊*]/).map((item) => item.trim());
      const id = String(rawId || "").replace(/[^\d]/g, "").padStart(3, "0");
      return { id, count: Number(String(count).replace(/[^\d.-]/g, "")) || 1 };
    });
}

function findCard(cards, id, key) {
  return cards.find((card) => String(card[key]) === String(id)) || null;
}

function cardConfig(type) {
  if (type === "attack") return { title: "攻击", cards: getAttackCards(), idKey: "A_card_ID" };
  if (type === "defense") return { title: "防御", cards: getDefenseCards(), idKey: "D_card_ID" };
  return { title: "通用", cards: getUtilityCards(), idKey: "U_card_ID" };
}

function expandUnitDeck(unit) {
  if (!unit) return [];
  const groups = [
    { type: "attack", refs: unit.attack_cards },
    { type: "defense", refs: unit.defense_cards },
    { type: "utility", refs: unit.utility_cards },
  ];
  const deck = [];
  for (const group of groups) {
    const copyCounts = new Map();
    for (const { id, count } of parseCardRefs(group.refs)) {
      const config = cardConfig(group.type);
      const card = findCard(config.cards, id, config.idKey);
      for (let i = 0; i < count; i += 1) {
        const nextCopy = (copyCounts.get(id) || 0) + 1;
        copyCounts.set(id, nextCopy);
        deck.push({
          key: `${group.type}:${id}:${nextCopy}`,
          type: group.type,
          id,
          copy: nextCopy,
          card,
        });
      }
    }
  }
  return deck;
}

function getDeckRemovalDraft(me, unit, index = 0) {
  const roomId = state.room?.id || "";
  const unitIds = selectedUnitIdsFor(me);
  const key = unitIds.join("|");
  if (state.deckRemovalDraft.roomId !== roomId || state.deckRemovalDraft.unitId !== key) {
    state.deckRemovalDraft = {
      roomId,
      unitId: key,
      keys: Array.isArray(me?.deckRemovals) ? [...me.deckRemovals] : [],
      keysByUnit: unitIds.map((_, slot) => [...asArray(me?.deckRemovalsByUnit?.[slot])]),
    };
  }
  state.deckRemovalDraft.keysByUnit ||= [];
  state.deckRemovalDraft.keysByUnit[index] ||= [];
  return state.deckRemovalDraft;
}

function findBattleSelf() {
  return findOwnedBattleUnits()[0] || null;
}

function findOwnedBattleUnits() {
  return asArray(state.room?.battle?.players).filter((player) => player.username === state.user?.username || player.ownerUsername === state.user?.username);
}

function selectedPilotIdsFor(player) {
  return asArray(player?.selectedPilotIds).length ? asArray(player.selectedPilotIds) : player?.selectedPilotId ? [player.selectedPilotId] : [];
}

function selectedUnitIdsFor(player) {
  return asArray(player?.selectedUnitIds).length ? asArray(player.selectedUnitIds) : player?.selectedUnitId ? [player.selectedUnitId] : [];
}

function battleCardLabel(entry) {
  const config = cardConfig(entry?.type);
  const card = findCard(config.cards, entry?.id, config.idKey);
  return card?.name || entry?.id || "-";
}

function battleCardImage(entry) {
  const config = cardConfig(entry?.type);
  const card = findCard(config.cards, entry?.id, config.idKey);
  return cardImageAsset(card?.card_picture);
}

function battleCardCooldown(entry) {
  return Math.max(0, Number(battleCardData(entry)?.CD || 0));
}

function duplicateCooldownCardInActions(actions) {
  const seen = new Map();
  for (const action of asArray(actions)) {
    const token = battleCardToken(action?.actorUsername, action?.cardKey);
    const entry = findHandEntryByKey(token);
    if (!entry || battleCardCooldown(entry) <= 0) continue;
    const key = battleCardToken(action?.actorUsername || entry.actorUsername, entry.key);
    if (seen.has(key)) return entry;
    seen.set(key, entry);
  }
  return null;
}

function battleActionType(action) {
  const entry = findHandEntryByKey(battleCardToken(action?.actorUsername, action?.cardKey));
  return entry?.type || String(action?.cardKey || "").split(":")[0] || "unknown";
}

function battleCardData(entry) {
  const config = cardConfig(entry?.type);
  return findCard(config.cards, entry?.id, config.idKey) || null;
}

function utilityMovementKindForEntry(entry) {
  if (entry?.type !== "utility") return "";
  const card = battleCardData(entry) || {};
  const id = String(card.U_card_ID || entry.id || "").padStart(3, "0");
  const text = `${card.name || ""} ${card.description || ""} ${card.effect || ""}`;
  if (["006", "007", "008", "009"].includes(id) || text.includes("突击")) return "charge";
  if (["001", "002", "003", "004", "005"].includes(id) || text.includes("移动")) return "move";
  if (["010", "011", "012", "013"].includes(id) || text.includes("闪现")) return "teleport";
  return "";
}

function movementLimitForEntry(entry) {
  const card = battleCardData(entry) || {};
  return Number(String(card.name || card.description || card.effect || "").match(/\d+/)?.[0] || 0);
}

function actionPathCoords(action) {
  return asArray(action?.targetPath || action?.path).filter(Array.isArray);
}

function actionTargetCoord(action) {
  const path = actionPathCoords(action);
  return path.length ? path[path.length - 1] : action?.target || null;
}

function isBattleCoordWalkable(coord) {
  const tile = asArray(state.room?.mapTiles).find((item) => coordKey(item.coord) === coordKey(coord));
  return Boolean(tile && !tile.blocking);
}

function getBattleDraft() {
  const battle = state.room?.battle;
  const owned = findOwnedBattleUnits();
  const roomId = state.room?.id || "";
  const round = battle?.round || 0;
  if (state.battleDraft.roomId !== roomId || state.battleDraft.round !== round) {
    const existingActions = new Map(
      owned.flatMap((unit) =>
        asArray(unit?.actions).map((action) => [action.actorUsername || unit.username, { ...action, actorUsername: action.actorUsername || unit.username }])
      )
    );
    state.battleDraft = {
      roomId,
      round,
      actions: owned.map((unit, turn) => {
        const existing = existingActions.get(unit.username) || {};
        return {
        turn,
        actorUsername: unit.username,
        ...existing,
        preSpiritTargetUsername: existing.preSpiritTargetUsername || "",
        postSpiritTargetUsername: existing.postSpiritTargetUsername || "",
        target: actionTargetCoord(existing) || null,
        targetPath: actionPathCoords(existing),
      };
      }),
      reserveKeys: [],
    };
    if (!state.battleDraft.actions.length) state.battleDraft.actions = [emptyBattleAction(0)];
    state.activeBattleTurn = 0;
  }
  return state.battleDraft;
}

function findHandEntryByKey(key) {
  const parsed = parseBattleCardToken(key);
  if (parsed.actorUsername) {
    const unit = findOwnedBattleUnits().find((item) => item.username === parsed.actorUsername);
    const entry = asArray(unit?.hand).find((item) => item.key === parsed.cardKey);
    return entry ? { ...entry, actorUsername: unit.username } : null;
  }
  for (const unit of findOwnedBattleUnits()) {
    const entry = asArray(unit?.hand).find((item) => item.key === parsed.cardKey);
    if (entry) return { ...entry, actorUsername: unit.username };
  }
  return null;
}

function findBattleUnitForCardKey(key) {
  const parsed = parseBattleCardToken(key);
  return findOwnedBattleUnits().find((unit) => unit.username === parsed.actorUsername || asArray(unit?.hand).some((entry) => entry.key === parsed.cardKey)) || null;
}

function parseBattleCardToken(value) {
  const text = String(value || "");
  const index = text.indexOf("::");
  if (index < 0) return { actorUsername: "", cardKey: text };
  return { actorUsername: text.slice(0, index), cardKey: text.slice(index + 2) };
}

function battleCardToken(actorUsername, cardKey) {
  return `${actorUsername || ""}::${cardKey || ""}`;
}

function battleCoordToPercent(coord) {
  const bounds = state.room?.mapBounds || { minX: -12.2, maxX: 19.1, minY: -22.6, maxY: 10.6 };
  const [q, r] = Array.isArray(coord) ? coord : [0, 0];
  const x = Math.sqrt(3) * (Number(q) + Number(r) / 2);
  const y = 1.5 * Number(r);
  const margin = 72 / 34;
  const width = Math.max(1, bounds.maxX - bounds.minX + Math.sqrt(3) + margin * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + 2 + margin * 2);
  const left = ((x - bounds.minX + margin + Math.sqrt(3) / 2) / width) * 100;
  const top = ((y - bounds.minY + margin + 1) / height) * 100;
  return {
    left: Math.max(2, Math.min(98, left)),
    top: Math.max(2, Math.min(98, top)),
  };
}

function coordKey(coord) {
  return Array.isArray(coord) ? `${coord[0]},${coord[1]}` : "";
}

function axialDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
  const [aq, ar] = a.map(Number);
  const [bq, br] = b.map(Number);
  return Math.max(Math.abs(aq - bq), Math.abs(ar - br), Math.abs(aq + ar - bq - br));
}

function currentResolutionEvent() {
  const battle = state.room?.battle || {};
  const events = asArray(battle.resolutionEvents);
  if (battle.stage !== "resolved" || !events.length || state.resolutionPlayback.skipped) return null;
  const index = Math.min(state.resolutionPlayback.index || 0, events.length - 1);
  return events[index] || null;
}

function getVisibleCoords() {
  if (state.room?.mode === "ai_sim" && asArray(state.room?.players).some((player) => player.username === state.user?.username && player.observer)) {
    return new Set(asArray(state.room?.mapTiles).map((tile) => coordKey(tile.coord)));
  }
  const replayVisible = asArray(currentResolutionEvent()?.animation?.visibleCoords);
  if (replayVisible.length) return new Set(replayVisible);
  const self = findBattleSelf();
  const radius = Number(state.room?.mapViewRadius || 5);
  const alliedUnits = asArray(state.room?.battle?.players).filter(
    (player) => player.team === self?.team && player.combat?.alive !== false && Array.isArray(player.combat?.coord)
  );
  const alliedBases = Object.values(state.room?.bases || {}).filter(
    (base) => base.team === self?.team && Number(base.hp ?? 1) > 0 && Array.isArray(base.coord)
  );
  const visionSources = [
    ...alliedUnits.map((player) => ({ coord: player.combat.coord, radius })),
    ...alliedBases.map((base) => ({ coord: base.coord, radius: Number(base.visionRadius || radius) })),
  ];
  const visible = new Set();
  for (const tile of asArray(state.room?.mapTiles)) {
    if (visionSources.some((source) => axialDistance(source.coord, tile.coord) <= source.radius)) {
      visible.add(coordKey(tile.coord));
    }
  }
  return visible;
}

function isCoordVisible(coord) {
  return getVisibleCoords().has(coordKey(coord));
}

function battleHexPolygonPoints(coord, scale = 1) {
  const pos = battleCoordToPercent(coord);
  const hex = battleHexSizePercent();
  const halfWidth = (hex.width * scale) / 2;
  const halfHeight = (hex.height * scale) / 2;
  const points = [
    [pos.left - halfWidth * 0.5, pos.top - halfHeight],
    [pos.left + halfWidth * 0.5, pos.top - halfHeight],
    [pos.left + halfWidth, pos.top],
    [pos.left + halfWidth * 0.5, pos.top + halfHeight],
    [pos.left - halfWidth * 0.5, pos.top + halfHeight],
    [pos.left - halfWidth, pos.top],
  ];
  return points.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(" ");
}

function renderBattleVisionLayer(map) {
  const visible = getVisibleCoords();
  const visibleTiles = asArray(state.room?.mapTiles).filter((tile) => visible.has(coordKey(tile.coord)));
  if (!visibleTiles.length) return "";
  const clipId = `battle-vision-${String(state.room?.id || "room").replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const polygons = visibleTiles
    .map((tile) => `<polygon points="${battleHexPolygonPoints(tile.coord, 1)}"></polygon>`)
    .join("");
  return `
    <svg class="battle-map-vision" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${polygons}</clipPath>
      </defs>
      <image href="${normalizeMapImage(map?.terrain_light_image)}" width="100" height="100" preserveAspectRatio="none" clip-path="url(#${clipId})"></image>
    </svg>`;
}

function renderBattleFogTiles() {
  const visible = getVisibleCoords();
  const hex = battleHexSizePercent();
  return asArray(state.room?.mapTiles)
    .filter((tile) => !visible.has(coordKey(tile.coord)))
    .map((tile) => {
      const pos = battleCoordToPercent(tile.coord);
      return `<span class="battle-fog-tile" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width * 1.02}%; --hex-height:${hex.height * 1.02}%;"></span>`;
    })
    .join("");
}

function renderBattleFlameTiles() {
  const hex = battleHexSizePercent();
  const flameCoords = asArray(state.room?.flameTiles).length
    ? asArray(state.room?.flameTiles)
    : asArray(state.room?.mapTiles)
        .filter((tile) => tile.type === "flame")
        .map((tile) => tile.coord);
  return flameCoords
    .filter((coord) => Array.isArray(coord))
    .map((coord) => {
      const pos = battleCoordToPercent(coord);
      return `<span class="battle-flame-tile" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width * 1.03}%; --hex-height:${hex.height * 1.03}%;"></span>`;
    })
    .join("");
}

function battleHexSizePercent() {
  const bounds = state.room?.mapBounds || { minX: -12.2, maxX: 19.1, minY: -22.6, maxY: 10.6 };
  const margin = 72 / 34;
  const width = Math.max(1, bounds.maxX - bounds.minX + Math.sqrt(3) + margin * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + 2 + margin * 2);
  return {
    width: Math.max(2.8, Math.min(7.5, (Math.sqrt(3) / width) * 100)),
    height: Math.max(3.2, Math.min(8.5, (2 / height) * 100)),
  };
}

function battleMapStackStyle() {
  const zoom = Number(state.battleMapZoom || 1);
  return `--map-scale:${zoom};`;
}

function renderNewbieGuideModal() {
  return `
    <div class="guide-backdrop" data-action="close-newbie-guide">
      <article class="guide-modal" role="dialog" aria-modal="true" aria-labelledby="newbieGuideTitle">
        <div class="guide-head">
          <div>
            <span class="badge">新手指南</span>
            <h2 id="newbieGuideTitle">第一次出击怎么打</h2>
          </div>
          <button class="ghost guide-close" type="button" data-action="close-newbie-guide">×</button>
        </div>
        <div class="guide-body">
          <section>
            <h3>1. 胜利目标</h3>
            <p>不同地图的胜利条件可能不同。001 地图要摧毁敌方主基地；002 单挑战场则是击坠敌方机甲即胜利。</p>
          </section>
          <section>
            <h3>2. 开局流程</h3>
            <ol>
              <li>创建或加入房间，选择 Team I 或 Team II。</li>
              <li>房主选择地图和规则，双方玩家准备后开始游戏。</li>
              <li>依次选择驾驶员、机甲，并在战斗卡组里删除至多两张牌。</li>
              <li>所有玩家确认后进入正式战斗。</li>
            </ol>
          </section>
          <section>
            <h3>3. 一回合要做什么</h3>
            <p>每回合抽牌后，你要给 3 轮行动分别设定卡牌和目标。所有玩家都点击“行动设定完毕”后，系统按行动顺序播放 3 轮结算。</p>
            <p>同一回合内，同一种 CD 大于 0 的牌最多只能设定一次。冷却中的牌可以保留到下回合，最多保留两张。</p>
          </section>
          <section>
            <h3>4. 卡牌类型</h3>
            <ul>
              <li><strong>攻击牌：</strong>选择目标格，命中范围内的敌人或基地会造成伤害；不会伤害使用者自己，但会伤害队友。</li>
              <li><strong>防御牌：</strong>通常在本轮等待敌方攻击时生效，可减伤、闪避、顶盾或协助队友。</li>
              <li><strong>通用牌：</strong>包括移动、突击、闪现等。移动会检查无障碍最短路径；突击遇到障碍会停在障碍前。</li>
              <li><strong>精神：</strong>从行动槽左侧下拉框选择；若需要指定对象，会出现目标下拉框，目标不受视野限制。</li>
            </ul>
          </section>
          <section>
            <h3>5. 地图与视野</h3>
            <p>亮图是当前视野内区域，暗图是视野外区域。基地、障碍物和机甲都会影响移动是否合法。滚轮缩放地图时会以鼠标位置为中心缩放。</p>
            <p>地图上黄色六边形框是你的机甲；敌人有红色细框，队友有绿色细框。</p>
          </section>
          <section>
            <h3>6. 结算与击坠</h3>
            <p>进入结算后，3 轮按行动顺序执行。机甲即便本回合会被击坠，也会等 3 轮全部结算完才真正消失，避免提前暴露结果。</p>
            <p>待复活时 HP、EN、SP 都为 0，并在 buff/debuff 区显示“复活中”。复活时会回到地图设定的复活点。</p>
          </section>
          <section>
            <h3>7. 快速提示</h3>
            <ul>
              <li>悬停或点击行动顺序玩家框，可以查看该玩家删牌后的战斗卡组。</li>
              <li>鼠标指向格子可以查看格上单位；按 Q/W 可以看驾驶员或机甲详情。</li>
              <li>测试平衡时可以用“AI模拟测试”，它不会播放动画，会直接给出多局统计。</li>
            </ul>
          </section>
        </div>
      </article>
    </div>`;
}

function renderShell(content) {
  if (!state.detailKey) hideFloatingTooltip();
  const isBattleScreen = state.view === "room" && state.room?.status === "started" && state.room?.phase === "battle";
  document.body.classList.toggle("battle-screen", Boolean(isBattleScreen));
  const userChip = state.user
    ? `<div class="user-chip">
        ${state.user.avatar ? `<img class="avatar" src="${state.user.avatar}" alt="">` : `<span class="avatar"></span>`}
        <span>${escapeHtml(state.user.nickname)}</span>
        <button class="ghost" data-action="open-newbie-guide">新手指南</button>
        <button class="ghost" data-action="logout">退出</button>
      </div>`
    : "";

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <h1>机器人大战多人版</h1>
        <p>回合制战棋 + 卡牌构筑 + 多人房间原型</p>
      </div>
      ${userChip}
    </header>
    ${content}
    ${state.showNewbieGuide ? renderNewbieGuideModal() : ""}
  `;
}

function render() {
  if (state.view === "auth") renderAuth();
  if (state.view === "lobby") renderLobby();
  if (state.view === "room") renderRoom();
  bindGlobalActions();
}

function renderAuth() {
  stopPolling();
  renderShell(`
    <section class="auth-card panel">
      <div class="auth-layout">
        <form id="loginForm">
          <h2>老用户登录</h2>
          <div class="field">
            <label>用户名</label>
            <input name="username" autocomplete="username" required />
          </div>
          <div class="field">
            <label>密码</label>
            <input name="password" type="password" autocomplete="current-password" required />
          </div>
          <div class="actions">
            <button class="primary" type="submit">登录</button>
          </div>
          <p id="loginStatus" class="status"></p>
        </form>

        <form id="registerForm">
          <h2>新用户注册</h2>
          <div class="field">
            <label>用户名</label>
            <input name="username" autocomplete="username" placeholder="3-18 位字母/数字/下划线" required />
          </div>
          <div class="field">
            <label>密码</label>
            <input name="password" type="password" autocomplete="new-password" required />
          </div>
          <div class="field">
            <label>游戏昵称</label>
            <input name="nickname" required />
          </div>
          <div class="field">
            <label>玩家头像</label>
            <input name="avatar" type="file" accept="image/*" />
          </div>
          <div class="actions">
            <button class="primary" type="submit">注册并登录</button>
          </div>
          <p id="registerStatus" class="status"></p>
        </form>
      </div>
    </section>
  `);

  document.querySelector("#loginForm").addEventListener("submit", onLogin);
  document.querySelector("#registerForm").addEventListener("submit", onRegister);
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  captureAiSimulationDraft(form);
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: {
        username: form.get("username"),
        password: form.get("password"),
      },
    });
    enterSession(result);
  } catch (error) {
    setStatus("loginStatus", error.message, "error");
  }
}

function readAvatar(file) {
  return new Promise((resolve) => {
    if (!file || !file.size) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

async function onRegister(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const avatar = await readAvatar(form.get("avatar"));
    const result = await api("/api/register", {
      method: "POST",
      body: {
        username: form.get("username"),
        password: form.get("password"),
        nickname: form.get("nickname"),
        avatar,
      },
    });
    enterSession(result);
  } catch (error) {
    setStatus("registerStatus", error.message, "error");
  }
}

async function enterSession(result) {
  state.sessionId = result.sessionId;
  state.user = result.user;
  localStorage.setItem("rb_session", state.sessionId);
  state.view = "lobby";
  await refreshRooms();
  render();
}

async function refreshRooms() {
  const result = await api("/api/rooms");
  state.rooms = result.rooms;
}

function renderLobby() {
  stopPolling();
  const roomRows = state.rooms.length
    ? state.rooms
        .map((room) => {
          const map = findMap(room.mapId);
          return `
            <div class="room-row">
              <div>
                <strong>${escapeHtml(room.name)}</strong>
                <div class="muted">${room.id} · ${room.players.length}/12 人 · ${escapeHtml(map?.name || "未选择地图")}</div>
              </div>
              <span class="badge">${room.status === "waiting" ? "等待中" : "已开始"}</span>
              <button data-action="join-room" data-room-id="${room.id}" ${room.status !== "waiting" ? "disabled" : ""}>加入</button>
            </div>`;
        })
        .join("")
    : `<div class="empty">还没有房间。你可以先创建一个游戏房间。</div>`;

  renderShell(`
    <section class="grid">
      <article class="panel main-actions">
        <div>
          <strong>创建游戏</strong>
          <p>建立一个房间，等待其他玩家加入。房主可在房间内选择地图和规则。</p>
        </div>
        <form id="createRoomForm" class="actions">
          <input name="name" placeholder="房间名称" />
          <button class="primary" type="submit">创建游戏</button>
        </form>
        <p id="createRoomStatus" class="status"></p>
      </article>

      <article class="panel main-actions">
        <div>
          <strong>加入游戏</strong>
          <p>输入房间号加入，或从下方房间列表选择。</p>
        </div>
        <form id="joinRoomForm" class="actions">
          <input name="roomId" placeholder="例如 ROOM_ABC123" />
          <button type="submit">加入游戏</button>
        </form>
        <p id="joinRoomStatus" class="status"></p>
      </article>

      <article class="panel main-actions">
        <div>
          <strong>新手指南</strong>
          <p>第一次开战前可以先看一遍。里面包含房间流程、三轮行动、卡牌类型、视野、击坠和复活规则。</p>
        </div>
        <button class="ghost" type="button" data-action="open-newbie-guide">查看指南</button>
      </article>

      ${renderAiSimulationPanel()}

      <article class="panel secondary-panel">
        <h2>房间列表</h2>
        <div class="room-list">${roomRows}</div>
      </article>

      <article class="panel secondary-panel">
        <h2>战斗数据库</h2>
        ${renderDatabase()}
      </article>
    </section>
  `);

  document.querySelector("#createRoomForm").addEventListener("submit", onCreateRoom);
  document.querySelector("#joinRoomForm").addEventListener("submit", onJoinRoomByCode);
  document.querySelector("#aiSimulationForm")?.addEventListener("submit", onCreateAiSimulation);
  document.querySelectorAll("[data-action='join-room']").forEach((button) => {
    button.addEventListener("click", () => joinRoom(button.dataset.roomId, "joinRoomStatus"));
  });
  bindDatabaseTabs();
}

function renderAiSimulationPanel() {
  const maps = getMaps();
  const pilots = getPilots();
  const units = getPlayableUnits();
  const selectedAiMapId = aiSimulationDraftValue("mapId", state.aiSimulationMapId || DEFAULT_AI_MAP_ID);
  const defaultPilotId = pilots.some((pilot) => String(pilot.pilot_ID) === DEFAULT_AI_PILOT_ID)
    ? DEFAULT_AI_PILOT_ID
    : String(pilots[0]?.pilot_ID || "");
  const fallbackUnitId = (offset = 0) => String(units[offset % Math.max(1, units.length)]?.unit_ID || "");
  const mapOptions = maps
    .map((map) => `<option value="${escapeHtml(map.map_ID)}" ${String(map.map_ID) === String(selectedAiMapId) ? "selected" : ""}>${escapeHtml(map.name || map.map_ID)}</option>`)
    .join("");
  const pilotOptions = (selectedId = defaultPilotId) =>
    pilots
      .map((pilot) => `<option value="${escapeHtml(pilot.pilot_ID)}" ${String(pilot.pilot_ID) === String(selectedId) ? "selected" : ""}>${escapeHtml(pilot.pilot_name || pilot.pilot_ID)}</option>`)
      .join("");
  const unitOptions = (selectedId = "") =>
    units
      .map((unit) => `<option value="${escapeHtml(unit.unit_ID)}" ${String(unit.unit_ID) === String(selectedId) ? "selected" : ""}>${escapeHtml(unit.unit_name || unit.unit_ID)}</option>`)
      .join("");
  const rows = (prefix, title, offset) => `
    <div class="ai-sim-team">
      <h4>${title}</h4>
      <label class="field compact">
        <span>AI 数量</span>
        <select name="${prefix}Count">
          ${[1, 2, 3, 4].map((count) => `<option value="${count}" ${String(count) === String(aiSimulationDraftValue(`${prefix}Count`, "1")) ? "selected" : ""}>${count}</option>`).join("")}
        </select>
      </label>
      ${[0, 1, 2, 3]
        .map(
          (index) => `
            <div class="ai-sim-row" data-ai-row="${prefix}-${index}">
              <span>AI ${index + 1}</span>
              <select name="${prefix}Pilot${index}">${pilotOptions(aiSimulationDraftValue(`${prefix}Pilot${index}`, defaultPilotId))}</select>
              <select name="${prefix}Unit${index}">${unitOptions(aiSimulationDraftValue(`${prefix}Unit${index}`, fallbackUnitId(offset + index)))}</select>
              <input name="${prefix}Remove${index}" value="${escapeHtml(aiSimulationDraftValue(`${prefix}Remove${index}`, ""))}" placeholder="删牌key，逗号分隔，可空" />
            </div>`
        )
        .join("")}
    </div>`;
  return `
    <article class="panel ai-sim-panel">
      <div class="settings-head">
        <h2>AI模拟测试</h2>
        <span class="badge">开发者</span>
      </div>
      <form id="aiSimulationForm" class="ai-sim-form">
        <label class="field compact">
          <span>地图</span>
          <select name="mapId">${mapOptions}</select>
        </label>
        <div class="ai-sim-run-settings">
          <label class="field compact">
            <span>重复对战次数</span>
            <input name="repeatCount" type="number" min="1" max="5000" value="${escapeHtml(aiSimulationDraftValue("repeatCount", "100"))}" />
          </label>
          <label class="field compact">
            <span>单局最大回合</span>
            <input name="maxRounds" type="number" min="1" max="300" value="${escapeHtml(aiSimulationDraftValue("maxRounds", "80"))}" />
          </label>
        </div>
        <div class="ai-sim-grid">
          ${rows("teamI", "Team I", 0)}
          ${rows("teamII", "Team II", 4)}
        </div>
        <div class="actions">
          <button class="primary" type="submit">运行AI批量模拟</button>
          <span class="muted">后台直接结算，不播放动画。</span>
        </div>
        <p id="aiSimulationStatus" class="status"></p>
      </form>
      ${renderAiSimulationBatchResult()}
    </article>`;
}

function renderAiSimulationBatchResult() {
  const result = state.aiSimulationResult;
  if (!result) return "";
  const playerRows = asArray(result.playerAverages)
    .map(
      (player) => `
        <div class="ai-sim-stat-row ${player.team === "Team I" ? "team-i" : "team-ii"}">
          <strong>${escapeHtml(player.team)} / ${escapeHtml(player.pilotName || "-")} / ${escapeHtml(player.unitName || "-")}</strong>
          <span>击坠 ${player.averageKills}</span>
          <span>被击坠 ${player.averageDeaths}</span>
          <span>助攻 ${player.averageAssists}</span>
        </div>`
    )
    .join("");
  return `
    <section class="ai-sim-batch-result">
      <div class="settings-head">
        <h4>批量模拟结果</h4>
        <span class="badge">${Number(result.repeatCount || 0)} 局</span>
      </div>
      <div class="ai-sim-summary-grid">
        <div><strong>${result.teamIWinRate}%</strong><span>Team I 胜率</span><small>${result.teamIWins || 0} 胜</small></div>
        <div><strong>${result.teamIIWinRate}%</strong><span>Team II 胜率</span><small>${result.teamIIWins || 0} 胜</small></div>
        <div><strong>${result.drawRate}%</strong><span>平局率</span><small>${result.draws || 0} 局</small></div>
        <div><strong>${result.averageRounds}</strong><span>平均回合数</span><small>上限 ${result.maxRounds || "-"}</small></div>
        <div><strong>${result.roundLimitGames || 0}</strong><span>达到回合上限</span><small>未摧毁基地</small></div>
        <div><strong>${result.averageTeamIBaseHp}/${result.averageTeamIIBaseHp}</strong><span>平均基地剩余HP</span><small>Team I / Team II</small></div>
      </div>
      <div class="ai-sim-player-averages">${playerRows}</div>
    </section>`;
}

function aiSimulationTeamFromForm(form, prefix) {
  const count = Math.max(1, Math.min(4, Number(form.get(`${prefix}Count`) || 1)));
  return Array.from({ length: count }).map((_, index) => ({
    pilotId: String(form.get(`${prefix}Pilot${index}`) || ""),
    unitId: String(form.get(`${prefix}Unit${index}`) || ""),
    removalKeys: String(form.get(`${prefix}Remove${index}`) || "")
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  }));
}

async function onCreateAiSimulation(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  captureAiSimulationDraft(form);
  setStatus("aiSimulationStatus", "正在批量模拟，请稍等...", "");
  try {
    const result = await api("/api/ai-simulations", {
      method: "POST",
      body: {
        sessionId: state.sessionId,
        mapId: form.get("mapId"),
        repeatCount: form.get("repeatCount"),
        maxRounds: form.get("maxRounds"),
        teamI: aiSimulationTeamFromForm(form, "teamI"),
        teamII: aiSimulationTeamFromForm(form, "teamII"),
      },
    });
    state.aiSimulationResult = result.summary;
    state.aiSimulationMapId = String(form.get("mapId") || DEFAULT_AI_MAP_ID);
    localStorage.setItem("rb_ai_sim_map", state.aiSimulationMapId);
    render();
    setStatus("aiSimulationStatus", "AI批量模拟完成。", "ok");
  } catch (error) {
    setStatus("aiSimulationStatus", error.message, "error");
  }
}

function renderDatabase() {
  const isUnits = state.databaseTab === "units";
  const items = isUnits
    ? getPlayableUnits()
    : getPilots()
        .filter((pilot) => pilot?.pilot_name && String(pilot.pilot_ID || "").padStart(3, "0") !== DEFAULT_AI_PILOT_ID)
        .slice(0, 12);
  return `
    <div class="database-tabs">
      <button class="${isUnits ? "active" : ""}" data-tab="units">机甲</button>
      <button class="${!isUnits ? "active" : ""}" data-tab="pilots">驾驶员</button>
    </div>
    <div class="cards-grid">
      ${items
        .map((item) => {
          if (isUnits) {
            return `<article class="data-card">
              <img class="database-preview-image" src="${normalizeAsset(item.icon || item.appearance)}" alt="" data-tooltip="database-unit" data-unit-id="${escapeHtml(item.unit_ID)}">
              <div>
                <h4>${escapeHtml(item.unit_name || item.unit_ID)}</h4>
                <p>HP ${item.max_HP || "-"} · EN ${unitMaxEn(item)} · 装甲 ${item.armor || "-"}</p>
              </div>
            </article>`;
          }
          return `<article class="data-card">
            <img class="database-preview-image" src="${normalizeAsset(item.face)}" alt="" data-tooltip="database-pilot" data-pilot-id="${escapeHtml(item.pilot_ID)}">
            <div>
              <h4>${escapeHtml(item.pilot_name || item.pilot_ID)}</h4>
              <p>${escapeHtml(item.type || "-")} · ${escapeHtml(item.region || "-")}</p>
              <p class="muted">SP ${item.max_SP || "-"}</p>
            </div>
          </article>`;
        })
        .join("")}
    </div>
  `;
}

function bindDatabaseTabs() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.databaseTab = button.dataset.tab;
      render();
    });
  });
}

async function onCreateRoom(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/rooms", {
      method: "POST",
      body: {
        sessionId: state.sessionId,
        name: form.get("name"),
        mapId: state.selectedMapId,
        rules: { pilotPickMode: "blind", unitPickMode: "free", friendlyAttackEffect: "full" },
      },
    });
    state.room = result.room;
    state.currentRoomId = result.room.id;
    state.view = "room";
    render();
    startRoomPolling();
  } catch (error) {
    setStatus("createRoomStatus", error.message, "error");
  }
}

async function onJoinRoomByCode(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await joinRoom(String(form.get("roomId") || "").trim(), "joinRoomStatus");
}

async function joinRoom(roomId, statusId) {
  if (!roomId) {
    setStatus(statusId, "请输入房间号", "error");
    return;
  }
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      body: { sessionId: state.sessionId },
    });
    state.room = result.room;
    state.currentRoomId = result.room.id;
    state.view = "room";
    render();
    startRoomPolling();
  } catch (error) {
    setStatus(statusId, error.message, "error");
  }
}

async function refreshRoom(shouldRender = true) {
  if (!state.currentRoomId) return;
  let result;
  try {
    result = await api(
      `/api/rooms/${encodeURIComponent(state.currentRoomId)}?sessionId=${encodeURIComponent(state.sessionId)}`
    );
  } catch {
    stopPolling();
    state.view = "lobby";
    await refreshRooms();
    render();
    return;
  }
  state.room = result.room;
  state.selectedMapId = result.room.mapId || state.selectedMapId;
  if (!shouldRender && shouldDeferRoomRender()) return;
  if (shouldRender || state.view === "room") {
    try {
      renderRoomPreservingScroll();
    } catch (error) {
      console.error(error);
      setStatus("roomStatus", error.message || "界面刷新失败", "error");
    }
  }
}

function shouldDeferRoomRender() {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  const battle = state.room?.battle || {};
  const events = asArray(battle.resolutionEvents);
  const resolutionPlaying =
    state.view === "room" &&
    state.room?.phase === "battle" &&
    battle.stage === "resolved" &&
    state.resolutionPlayback.key === resolutionPlaybackKey() &&
    document.querySelector(".resolution-board") &&
    !state.resolutionPlayback.skipped &&
    (state.resolutionPlayback.index || 0) < events.length;
  const editingPlanningSelect =
    state.room?.phase === "battle" &&
    battle.stage === "planning" &&
    active?.matches?.(".battle-slots select, .battle-hand-grid, .deck-preview");
  const pointerInScrollableBattlePanel = Boolean(
    state.room?.phase === "battle" &&
      battle.stage === "planning" &&
      document.querySelector(".deck-preview:hover, .battle-slots:hover")
  );
  return Boolean(editingPlanningSelect || pointerInScrollableBattlePanel) || resolutionPlaying;
}

function captureRoomScrollState() {
  if (typeof window === "undefined") return null;
  const mapViewport = document.querySelector("[data-action='map-wheel']");
  return {
    pageY: window.scrollY,
    pickLists: Array.from(document.querySelectorAll(".pick-list")).map((list) => list.scrollTop),
    battleHands: Array.from(document.querySelectorAll(".battle-hand-grid")).map((list, index) => ({
      left: list.scrollLeft || state.battleHandScroll[index]?.left || 0,
      top: list.scrollTop || state.battleHandScroll[index]?.top || 0,
    })),
    deckPreviews: Array.from(document.querySelectorAll(".deck-preview")).map((list, index) => ({
      left: list.scrollLeft || state.deckPreviewScroll[index]?.left || 0,
      top: list.scrollTop || state.deckPreviewScroll[index]?.top || 0,
    })),
    battleSlots: (() => {
      const list = document.querySelector(".battle-slots");
      return list
        ? {
            left: list.scrollLeft || state.battleSlotScroll?.left || 0,
            top: list.scrollTop || state.battleSlotScroll?.top || 0,
          }
        : null;
    })(),
    battleLogs: Array.from(document.querySelectorAll(".battle-log")).map((list) => ({
      left: list.scrollLeft || 0,
      top: list.scrollTop || 0,
    })),
    battleMap: mapViewport
      ? {
          left: mapViewport.scrollLeft,
          top: mapViewport.scrollTop,
        }
      : null,
  };
}

function restoreRoomScrollState(snapshot) {
  if (!snapshot || typeof window === "undefined") return;
  document.querySelectorAll(".pick-list").forEach((list, index) => {
    list.scrollTop = snapshot.pickLists[index] || 0;
  });
  restoreBattleHandScroll(snapshot);
  restoreDeckPreviewScroll(snapshot);
  restoreBattleSlotScroll(snapshot);
  restoreBattleMapScroll(snapshot);
  restoreBattleLogScroll(snapshot);
  window.scrollTo(0, snapshot.pageY || 0);
  const restoreAgain = () => {
    restoreBattleHandScroll(snapshot);
    restoreDeckPreviewScroll(snapshot);
    restoreBattleSlotScroll(snapshot);
    restoreBattleMapScroll(snapshot);
    restoreBattleLogScroll(snapshot);
    window.scrollTo(0, snapshot.pageY || 0);
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(restoreAgain);
  }
  setTimeout(restoreAgain, 60);
  setTimeout(restoreAgain, 220);
}

function restoreBattleHandScroll(snapshot) {
  document.querySelectorAll(".battle-hand-grid").forEach((list, index) => {
    const saved = snapshot?.battleHands?.[index] || state.battleHandScroll[index];
    if (!saved) return;
    list.scrollLeft = saved.left || 0;
    list.scrollTop = saved.top || 0;
  });
}

function restoreBattleMapScroll(snapshot) {
  const mapViewport = document.querySelector("[data-action='map-wheel']");
  if (!mapViewport || !snapshot?.battleMap) return;
  mapViewport.scrollLeft = snapshot.battleMap.left || 0;
  mapViewport.scrollTop = snapshot.battleMap.top || 0;
}

function restoreBattleLogScroll(snapshot) {
  document.querySelectorAll(".battle-log").forEach((list, index) => {
    const saved = snapshot?.battleLogs?.[index];
    if (!saved) return;
    list.scrollLeft = saved.left || 0;
    list.scrollTop = saved.top || 0;
  });
}

function renderRoomPreservingScroll() {
  const snapshot = captureRoomScrollState();
  renderRoom();
  restoreRoomScrollState(snapshot);
}

function renderRoom() {
  if (!state.room) {
    state.view = "lobby";
    render();
    return;
  }
  startRoomPolling();
  const roomPlayers = asArray(state.room.players);
  const me = roomPlayers.find((p) => p.username === state.user.username);
  const isHost = me?.isHost;
  const map = findMap(state.room.mapId);
  const isBattleStage = state.room.status === "started" && ["battle", "ended"].includes(state.room.phase);
  const isResolutionStage = state.room.status === "started" && state.room.phase === "battle" && state.room?.battle?.stage === "resolved";
  const roomLayoutClass =
    state.room.status === "started" && state.room.phase === "battle"
      ? `room-layout battle-phase${isResolutionStage ? " resolution-phase" : ""}`
      : state.room.status === "started" && ["loadout", "reveal", "ended"].includes(state.room.phase)
      ? "room-layout deck-phase"
      : "room-layout";
  const isBlindSelectionPhase =
    state.room.status === "started" && ["pilot", "unit", "loadout"].includes(state.room.phase) && me?.team;
  const visiblePlayers = isBlindSelectionPhase
    ? roomPlayers.filter((player) => player.team === me.team || player.username === me.username)
    : roomPlayers;
  const hiddenEnemyNote = isBlindSelectionPhase
    ? `<div class="empty compact">盲选阶段已隐藏敌方玩家信息。</div>`
    : "";
  const playerRows = visiblePlayers
    .map(
      (player) => `
      <div class="player-row">
        ${player.avatar ? `<img class="avatar" src="${player.avatar}" alt="">` : `<span class="avatar"></span>`}
        <div>
          <strong>${escapeHtml(player.nickname)}</strong>
        </div>
        <span class="badge ${player.team === "Team I" ? "team-i" : player.team === "Team II" ? "team-ii" : ""}">${player.team || "未选阵营"}</span>
        <span class="badge ${player.ready ? "ready" : ""}">${player.ready ? "已准备" : "未准备"}${player.isHost ? " · 房主" : ""}</span>
      </div>`
    )
    .join("");

  renderShell(`
    <section class="panel">
      <div class="${roomLayoutClass}">
        ${isBattleStage && !isResolutionStage ? renderBattleStatusSidebar() : isBattleStage ? "" : `
          <div>
            <h2>${escapeHtml(state.room.name)}</h2>
            <p>房间号：<strong>${state.room.id}</strong> · ${state.room.playerCount || roomPlayers.length}/12 人 · 状态：${state.room.status === "waiting" ? "等待中" : "已开始"}</p>
            <div class="room-map-summary">
              <img src="${normalizeMapImage(map?.terrain_light_image)}" alt="">
              <div>
                <span class="muted">当前地图</span>
                <strong>${escapeHtml(map?.name || "未选择地图")}</strong>
                <small>${escapeHtml(ruleLabel(state.room.rules))}</small>
              </div>
            </div>
            <div class="player-list">${playerRows}${hiddenEnemyNote}</div>
          </div>
        `}
        <div>
          ${state.room.status === "started" ? renderBattleSetup(me) : renderReadyPanel(me, isHost)}
        </div>
      </div>
    </section>
  `);

  bindRoomActions(me);
  bindGlobalActions();
  startResolutionPlayback();
  centerResolutionMapOnSelf();
  maybePlaySelfRespawnAnimation();
}

function renderReadyPanel(me, isHost) {
  const teamMaxPlayers = currentTeamMaxPlayers();
  const teamICount = Number(state.room?.teamICount || 0);
  const teamIICount = Number(state.room?.teamIICount || 0);
  const teamIFull = me?.team !== "Team I" && teamICount >= teamMaxPlayers["Team I"];
  const teamIIFull = me?.team !== "Team II" && teamIICount >= teamMaxPlayers["Team II"];
  return `
    <h3>房间准备</h3>
    <p>房主可以选择地图和规则。修改设置会让所有玩家重新确认准备状态。</p>
    ${renderMapSettings(isHost)}
    ${renderRuleSettings(isHost)}
    <h3 class="section-subtitle">阵营与准备</h3>
    <div class="team-controls">
      <button class="team-button team-i ${me?.team === "Team I" ? "active" : ""}" data-action="team" data-team="Team I" ${teamIFull ? "disabled" : ""}>Team I ${teamICount}/${teamMaxPlayers["Team I"]}</button>
      <button class="team-button team-ii ${me?.team === "Team II" ? "active" : ""}" data-action="team" data-team="Team II" ${teamIIFull ? "disabled" : ""}>Team II ${teamIICount}/${teamMaxPlayers["Team II"]}</button>
    </div>
    <div class="actions room-actions">
      <button class="${me?.ready ? "danger" : "primary"}" data-action="ready" ${!me?.team ? "disabled" : ""}>${me?.ready ? "取消准备" : "准备好了"}</button>
      <button class="primary" data-action="start" ${!isHost || !state.room.canStart ? "disabled" : ""}>开始游戏</button>
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p class="status ${state.room.canStart ? "ok" : ""}">
      Team I ${teamICount}/${teamMaxPlayers["Team I"]} players · Team II ${teamIICount}/${teamMaxPlayers["Team II"]} players · ${state.room.canStart ? "Ready to start" : "Waiting for teams, limits, and ready state"}
    </p>
    <p id="roomStatus" class="status"></p>
  `;
}

function renderBattleStatusSidebar() {
  const self = findBattleSelf();
  const selected = state.selectedBattleCoord || self?.combat?.coord || null;
  const tile = asArray(state.room?.mapTiles).find((item) => coordKey(item.coord) === coordKey(selected));
  const selectedVisible = isCoordVisible(selected);
  const players = asArray(state.room?.battle?.players).filter(
    (player) =>
      coordKey(player.combat?.coord) === coordKey(selected) &&
      (player.team === self?.team || selectedVisible)
  );
  const bases = Object.values(state.room?.bases || {}).filter((base) => coordKey(base.coord) === coordKey(selected));
  const treasures = asArray(state.room?.mapTreasures).filter((item) => coordKey(item.coord) === coordKey(selected));
  return `
    <aside class="battle-sidebar">
      <h3>战斗状态</h3>
      <section>
        <strong>当前格子</strong>
        <p>${formatCoord(selected)} · ${selectedVisible ? escapeHtml(tile?.inGameName || tile?.type || "未知") : "阴影区域"}${tile?.blocking && selectedVisible ? " · 障碍" : ""}</p>
        ${tile?.inGameText && selectedVisible ? `<p>${escapeHtml(tile.inGameText)}</p>` : ""}
      </section>
      <section class="unit-panel ${players.length || bases.length || treasures.length ? "" : "empty"}">
        ${players.length ? players.map(renderSidebarUnit).join("") : ""}
        ${bases.length ? bases.map(renderSidebarBase).join("") : ""}
        ${treasures.length ? treasures.map(renderSidebarTreasure).join("") : ""}
      </section>
      ${renderBattlePlans()}
    </aside>
  `;
}

function renderSidebarUnit(player) {
  const unit = findUnit(player.selectedUnitId);
  const pilot = player.selectedPilotId ? findPilot(player.selectedPilotId) : null;
  const pilotFace = pilot?.face || pilot?.icon || player.avatar;
  const unitFeatures = getUnitFeatures(player.selectedUnitId);
  const featureLabel = unitFeatures.map((feature) => feature.name || feature.feature_ID).filter(Boolean).join(" | ") || "无特性";
  return `
    <article class="status-object status-unit">
      <h4>格上单位</h4>
      <img class="status-unit-icon" src="${normalizeAsset(unit?.icon || unit?.appearance)}" alt="">
      <div class="status-unit-summary">
        <p>${escapeHtml(player.nickname)} (${escapeHtml(player.team || "-")}) <span>Kills: ${player.stats?.kills ?? 0}</span> <span>Death: ${player.stats?.deaths ?? 0}</span> <span>Assists: ${player.stats?.assists ?? 0}</span></p>
        <p>${escapeHtml(unit?.unit_name || "-")} HP ${player.combat?.hp ?? "-"} EN ${player.combat?.en ?? "-"} Armor ${player.combat?.effectiveArmor ?? player.combat?.armor ?? "-"}</p>
        <p>${escapeHtml(featureLabel)}</p>
      </div>
      <div class="status-unit-visuals">
        ${pilotFace ? `<img class="status-pilot-face" src="${normalizeAsset(pilotFace)}" alt="">` : `<span class="status-pilot-face">驾驶员图</span>`}
        ${unit?.appearance ? `<img class="status-unit-art" src="${normalizeAsset(unit.appearance)}" alt="">` : `<span class="status-unit-art">机甲图</span>`}
      </div>
      <div class="status-unit-help">
        <div>按Q/W显示详细信息</div>
      </div>
    </article>
  `;
}

function renderPilotDetailBlock(pilot) {
  if (!pilot) return "";
  const talents = getPilotTalents(pilot.pilot_ID);
  const spirits = getPilotSpirits(pilot.pilot_ID);
  return `
    <div class="status-detail-block">
      <strong>${escapeHtml(pilot.pilot_name || "-")}</strong>
      ${pilot.pilot_description ? `<p>${escapeHtml(pilot.pilot_description)}</p>` : ""}
      ${talents.map((talent) => `<p><b>${escapeHtml(talent.name || talent.talent_ID)}</b> ${escapeHtml(talent.description || talent.effect || "")}</p>`).join("")}
      ${spirits.map((spirit) => `<p><b>${escapeHtml(spirit.name || spirit.spirit_ID)}</b> SP ${escapeHtml(spirit.SP_cost || 0)} ${escapeHtml(spirit.description || spirit.effect || "")}</p>`).join("")}
    </div>`;
}

function renderPilotTextDetails(pilot) {
  if (!pilot) return `<div class="tooltip-empty">暂无驾驶员信息</div>`;
  const talents = getPilotTalents(pilot.pilot_ID);
  const spirits = getPilotSpirits(pilot.pilot_ID);
  const talentRows = talents.length
    ? talents
        .map((talent) => `<p><b>${escapeHtml(talent.name || talent.talent_ID)}</b> ${escapeHtml(talent.description || talent.effect || "")}</p>`)
        .join("")
    : `<p>暂无天赋</p>`;
  const spiritRows = spirits.length
    ? `<p><b>精神</b> ${escapeHtml(spirits.map((spirit) => spirit.name || spirit.spirit_ID).join(" / "))}</p>`
    : `<p><b>精神</b> 暂无</p>`;
  return `<div class="tooltip-text-detail">${talentRows}${spiritRows}</div>`;
}

function renderUnitTextDetails(unit) {
  if (!unit) return `<div class="tooltip-empty">暂无机甲信息</div>`;
  const features = getUnitFeatures(unit.unit_ID);
  const rows = features.length
    ? features
        .map((feature) => `<p><b>${escapeHtml(feature.name || feature.feature_ID)}</b> ${escapeHtml(feature.description || feature.effect || "")}</p>`)
        .join("")
    : `<p>暂无机甲特性</p>`;
  return `<div class="tooltip-text-detail">${rows}</div>`;
}

function restoreDeckPreviewScroll(snapshot) {
  document.querySelectorAll(".deck-preview").forEach((list, index) => {
    const saved = snapshot?.deckPreviews?.[index] || state.deckPreviewScroll[index];
    if (!saved) return;
    list.scrollLeft = saved.left || 0;
    list.scrollTop = saved.top || 0;
  });
}

function restoreBattleSlotScroll(snapshot) {
  const list = document.querySelector(".battle-slots");
  const saved = snapshot?.battleSlots || state.battleSlotScroll;
  if (!list || !saved) return;
  list.scrollLeft = saved.left || 0;
  list.scrollTop = saved.top || 0;
}

function renderDatabasePilotDescription(pilot) {
  if (!pilot) return `<div class="tooltip-empty">暂无驾驶员介绍</div>`;
  return `
    <div class="tooltip-text-detail database-pilot-description">
      <strong>${escapeHtml(pilot.pilot_name || pilot.pilot_ID)}</strong>
      <p>${escapeHtml(pilot.pilot_description || "暂无驾驶员介绍")}</p>
    </div>`;
}

function renderDatabaseUnitArt(unit) {
  if (!unit) return `<div class="tooltip-empty">暂无机甲图片</div>`;
  return `
    <div class="tooltip-unit-art">
      <strong>${escapeHtml(unit.unit_name || unit.unit_ID)}</strong>
      <img src="${normalizeAsset(unit.appearance || unit.icon)}" alt="">
    </div>`;
}

function renderUnitDetailBlock(unit, player = null) {
  if (!unit) return "";
  const features = getUnitFeatures(unit.unit_ID);
  const removals = new Set(asArray(player?.deckRemovals));
  const deck = expandUnitDeck(unit).filter((entry) => !removals.has(entry.key));
  const deckSummary = deck.map((entry) => entry.card?.name || entry.id).filter(Boolean).join(" / ") || "暂无卡牌";
  return `
    <div class="status-detail-block">
      <strong>${escapeHtml(unit.unit_name || "-")}</strong>
      <p>卡组：攻击 ${escapeHtml(unit.attack_cards || "-")} / 防御 ${escapeHtml(unit.defense_cards || "-")} / 通用 ${escapeHtml(unit.utility_cards || "-")}</p>
      <p>当前卡组：${escapeHtml(deckSummary)}</p>
      ${features.length ? features.map((feature) => `<p><b>${escapeHtml(feature.name || feature.feature_ID)}</b> ${escapeHtml(feature.description || feature.effect || "")}</p>`).join("") : "<p>暂无机甲特性</p>"}
    </div>`;
}

function renderSidebarBase(base) {
  return `
    <article class="status-object base">
      <span>基地</span>
      <div>
        <strong>${escapeHtml(base.team)} 基地</strong>
        <small>HP ${Math.max(0, base.hp)} / ${base.maxHP} · 装甲 ${base.armor || 0} · 视野 ${base.visionRadius || state.room?.mapViewRadius || 5}</small>
      </div>
    </article>
  `;
}

function renderSidebarTreasure(item) {
  return `
    <article class="status-object">
      <span>物资</span>
      <div>
        <strong>${escapeHtml(item.name || item.type || "补给品")}</strong>
        <small>${escapeHtml(item.description || "")}</small>
      </div>
    </article>
  `;
}

function renderMapSettings(isHost) {
  const maps = getMaps();
  const selected = findMap(state.room?.mapId);
  const mapCards = maps
    .map(
      (map) => `
        <button class="map-card ${String(map.map_ID) === String(state.room?.mapId) ? "active" : ""}" data-action="select-map" data-map-id="${escapeHtml(map.map_ID)}" ${!isHost ? "disabled" : ""}>
          <img src="${normalizeMapImage(map.terrain_light_image)}" alt="">
          <span>
            <strong>${escapeHtml(map.name)}</strong>
            <small>${escapeHtml(map.map_ID)}</small>
          </span>
        </button>`
    )
    .join("");
  return `
    <section class="room-settings">
      <div class="settings-head">
        <h4>地图选择</h4>
        <span class="badge">${isHost ? "房主可改" : "房主设置"}</span>
      </div>
      <div class="map-picker">${mapCards}</div>
      <article class="map-detail">
        <img src="${normalizeMapImage(selected?.terrain_light_image)}" alt="">
        <div>
          <strong>${escapeHtml(selected?.name || "未选择地图")}</strong>
          <p><span>地图描述</span>${escapeHtml(selected?.map_description || "暂无地图描述")}</p>
          <p><span>任务描述</span>${escapeHtml(selected?.task_description || "暂无任务描述")}</p>
        </div>
      </article>
    </section>
  `;
}

function renderRuleSettings(isHost) {
  const rules = state.room?.rules || { pilotPickMode: "blind", unitPickMode: "free", friendlyAttackEffect: "full" };
  return `
    <section class="room-settings">
      <div class="settings-head">
        <h4>游戏规则</h4>
        <span class="badge">${isHost ? "房主可改" : "房主设置"}</span>
      </div>
      <div class="rule-grid">
        <label class="field">
          <span>选人模式</span>
          <select data-action="rule-pilot" ${!isHost ? "disabled" : ""}>
            <option value="blind" ${rules.pilotPickMode === "blind" ? "selected" : ""}>盲选模式</option>
          </select>
        </label>
        <label class="field">
          <span>选机模式</span>
          <select data-action="rule-unit" ${!isHost ? "disabled" : ""}>
            <option value="free" ${rules.unitPickMode === "free" ? "selected" : ""}>任选模式</option>
          </select>
        </label>
        <label class="field">
          <span>攻击类卡牌对友军</span>
          <select data-action="rule-friendly-attack" ${!isHost ? "disabled" : ""}>
            <option value="full" ${rules.friendlyAttackEffect === "full" ? "selected" : ""}>友军受到全额伤害</option>
            <option value="half" ${rules.friendlyAttackEffect === "half" ? "selected" : ""}>友军受到50%伤害</option>
            <option value="immune" ${rules.friendlyAttackEffect === "immune" ? "selected" : ""}>友军免受伤害</option>
          </select>
        </label>
      </div>
      <p class="muted compact-note">更多规则位已预留，后续可以接入 ban/pick、总价模式等。</p>
    </section>
  `;
}

function ruleLabel(rules = {}) {
  const pilot = rules.pilotPickMode === "blind" ? "盲选" : "选人待定";
  const unit = rules.unitPickMode === "free" ? "任选机体" : "选机待定";
  const friendly =
    rules.friendlyAttackEffect === "half"
      ? "友军50%"
      : rules.friendlyAttackEffect === "immune"
        ? "友军免伤"
        : "友军全伤";
  return `${pilot} · ${unit} · ${friendly}`;
}

function renderBattleSetup(me) {
  const phase = state.room?.phase || "pilot";
  if (phase === "pilot") return renderPilotSelection(me);
  if (phase === "unit") return renderUnitSelection(me);
  if (phase === "loadout") return renderLoadoutSelection(me);
  if (phase === "reveal") return renderRevealSelection(me);
  if (phase === "battle") return renderBattlePlay(me);
  return renderBattleEnded(me);
}

function renderTeammateSelections(me, type) {
  const teammates = asArray(state.room?.players).filter((player) => player.team && player.team === me?.team);
  const rows = teammates
    .map((player) => {
      const selected =
        type === "pilot"
          ? findPilot(player.selectedPilotId)?.pilot_name
          : type === "unit"
            ? findUnit(player.selectedUnitId)?.unit_name
            : `${findPilot(player.selectedPilotId)?.pilot_name || "-"} / ${findUnit(player.selectedUnitId)?.unit_name || "-"}`;
      const confirmed =
        type === "pilot" ? player.pilotConfirmed : type === "unit" ? player.unitConfirmed : player.loadoutConfirmed;
      return `
        <div class="ally-row">
          ${player.avatar ? `<img class="avatar" src="${player.avatar}" alt="">` : `<span class="avatar"></span>`}
          <div>
            <strong>${escapeHtml(player.nickname)}</strong>
            <small>${escapeHtml(selected || "尚未选择")}</small>
          </div>
          <span class="badge ${confirmed ? "ready" : ""}">${confirmed ? "已确定" : "未确定"}</span>
        </div>`;
    })
    .join("");
  return `
    <section class="selection-status">
      <div class="settings-head">
        <h4>队友选择</h4>
        <span class="badge">敌方隐藏</span>
      </div>
      <div class="ally-list">${rows || `<div class="empty compact">请先选择阵营</div>`}</div>
    </section>
  `;
}

function teammatePilotIds(me) {
  const ids = asArray(state.room?.players)
    .filter((player) => player.username !== me?.username && player.team && player.team === me?.team)
    .flatMap((player) => selectedPilotIdsFor(player));
  return new Set(ids.filter(Boolean));
}

function renderPilotSelection(me) {
  const selectedPilotIds = selectedPilotIdsFor(me);
  const selectedPilot = findPilot(selectedPilotIds[0] || state.selectedPilotId);
  const blocked = teammatePilotIds(me);
  return `
    <h3>阶段一：选择驾驶员</h3>
    <p>盲选模式下，你只能看到队友的选择与确认状态；敌方玩家信息不会显示。同队不能重复选择同一名驾驶员。</p>
    ${renderTeammateSelections(me, "pilot")}
    ${renderSelectCard("驾驶员", "pilot", getPilots(), selectedPilotIds, (item) => ({
      id: item.pilot_ID,
      name: item.pilot_name,
      image: item.face,
      meta: `${item.type || "-"} · ${item.region || "-"} · SP ${item.max_SP || "-"}`,
      disabled: blocked.has(String(item.pilot_ID)),
    }))}
    ${renderSelectionInfoPanel("pilot", selectedPilot)}
    <div class="actions room-actions">
      <button class="primary" data-action="confirm-stage" ${!selectedPilotIds.length || me?.pilotConfirmed ? "disabled" : ""}>确定</button>
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p id="roomStatus" class="status">${me?.pilotConfirmed ? "已确定，等待其他玩家。" : ""}</p>
  `;
}

function renderUnitSelection(me) {
  const selectedUnitIds = selectedUnitIdsFor(me);
  const pilotCount = Math.min(MAX_CONTROLLED_UNITS, selectedPilotIdsFor(me).length || 1);
  const selectedUnit = findUnit(selectedUnitIds[0] || state.selectedUnitId);
  return `
    <h3>阶段二：选择机甲</h3>
    <p>任选模式下，玩家可以自由选择机甲。机甲数量必须与驾驶员数量相同：${selectedUnitIds.length}/${pilotCount}。</p>
    ${renderTeammateSelections(me, "unit")}
    ${renderSelectCard("机体", "unit", getPlayableUnits(), selectedUnitIds, (item) => ({
      id: item.unit_ID,
      name: item.unit_name,
      image: item.icon || item.appearance,
      meta: `HP ${item.max_HP || "-"} · EN ${unitMaxEn(item)} · 装甲 ${item.armor || "-"}`,
    }))}
    ${renderSelectionInfoPanel("unit", selectedUnit)}
    ${renderUnitDeckPreview(selectedUnit)}
    <div class="actions room-actions">
      <button class="primary" data-action="confirm-stage" ${selectedUnitIds.length !== pilotCount || me?.unitConfirmed ? "disabled" : ""}>确定</button>
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p id="roomStatus" class="status">${me?.unitConfirmed ? "已确定，等待其他玩家。" : ""}</p>
  `;
}

function renderSelectionInfoPanel(type, item) {
  if (!item) {
    return `<section class="selection-info"><h4>详细信息</h4><p class="muted">请选择一个${type === "pilot" ? "驾驶员" : "机甲"}。</p></section>`;
  }
  if (type === "pilot") {
    const talents = getPilotTalents(item.pilot_ID);
    const spirits = getPilotSpirits(item.pilot_ID);
    return `
      <section class="selection-info">
        <h4>驾驶员详细信息</h4>
        <div class="selection-info-head">
          <img src="${normalizeAsset(item.face || item.icon)}" alt="">
          <div>
            <strong>${escapeHtml(item.pilot_name || item.pilot_ID)}</strong>
            <small>${escapeHtml(item.type || "-")} · ${escapeHtml(item.region || "-")} · SP ${escapeHtml(item.max_SP || "-")}</small>
          </div>
        </div>
        ${item.pilot_description || item.profile || item.description || item.introduction ? `<p>${escapeHtml(item.pilot_description || item.profile || item.description || item.introduction)}</p>` : ""}
        <div class="selection-info-list">
          <div class="info-group">
            <span class="info-label">天赋</span>
            ${talents.length ? talents.map((talent) => `<p><b>${escapeHtml(talent.name || talent.talent_ID)}</b> ${escapeHtml(talent.description || talent.effect || "")}</p>`).join("") : "<p>暂无天赋</p>"}
          </div>
          <div class="info-group">
            <span class="info-label">精神</span>
            ${spirits.length ? spirits.map((spirit) => `<p><b>${escapeHtml(spirit.name || spirit.spirit_ID)}</b> ${escapeHtml(spirit.description || spirit.effect || "")}</p>`).join("") : "<p>暂无精神技能</p>"}
          </div>
        </div>
      </section>`;
  }
  const features = getUnitFeatures(item.unit_ID);
  return `
    <section class="selection-info">
      <h4>机甲详细信息</h4>
      <div class="selection-info-head">
        <img src="${normalizeAsset(item.icon || item.appearance)}" alt="">
        <div>
          <strong>${escapeHtml(item.unit_name || item.unit_ID)}</strong>
          <small>HP ${escapeHtml(item.max_HP || "-")} · EN ${escapeHtml(unitMaxEn(item))} · 装甲 ${escapeHtml(item.armor || "-")}</small>
        </div>
      </div>
      ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
      <div class="selection-info-list">
        ${features.length ? features.map((feature) => `<p><b>${escapeHtml(feature.name || feature.feature_ID)}</b> ${escapeHtml(feature.description || feature.effect || "")}</p>`).join("") : "<p>暂无机甲特性</p>"}
      </div>
    </section>`;
}

function renderLoadoutSelection(me) {
  const unitIds = selectedUnitIdsFor(me);
  const pilotIds = selectedPilotIdsFor(me);
  const map = findMap(state.room?.mapId);
  const draft = getDeckRemovalDraft(me, findUnit(unitIds[0]), 0);
  const loadoutBlocks = unitIds
    .map((unitId, index) => {
      const unit = findUnit(unitId);
      const pilot = findPilot(pilotIds[index]);
      const removals = new Set(asArray(draft.keysByUnit?.[index]));
      const remaining = expandUnitDeck(unit).length - removals.size;
      return `
        <div class="deployment-card">
          <img src="${normalizeAsset(pilot?.face)}" alt="">
          <img src="${normalizeAsset(unit?.icon || unit?.appearance)}" alt="">
          <div>
            <strong>${escapeHtml(pilot?.pilot_name || "-")} / ${escapeHtml(unit?.unit_name || "-")}</strong>
            <span>${escapeHtml(me?.team || "未分队")} · 战斗牌 ${remaining}/8</span>
          </div>
        </div>
        ${renderEditableUnitDeck(unit, removals, me?.loadoutConfirmed, index)}`;
    })
    .join("");
  return `
    <h3>阶段三：调整战斗卡组</h3>
    <p>每台机甲需要从完整卡组中删除若干张牌，直到战斗牌数量不超过 8 张。</p>
    ${renderTeammateSelections(me, "loadout")}
    <div class="battle-preview">
      <div>
        <span class="muted">本局地图</span>
        <strong>${escapeHtml(map?.name || "训练竞技场")}</strong>
        <p>${escapeHtml(map?.task_description || "摧毁对方主基地。")}</p>
      </div>
      <img class="battle-map-thumb" src="${normalizeMapImage(map?.terrain_light_image)}" alt="">
    </div>
    ${loadoutBlocks}
    <div class="actions room-actions">
      <button class="primary" data-action="confirm-loadout" ${me?.loadoutConfirmed ? "disabled" : ""}>确定</button>
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p id="roomStatus" class="status">${me?.loadoutConfirmed ? "已确定卡组，等待其他玩家。" : ""}</p>
  `;
}

function renderEditableUnitDeck(unit, removalSet, locked = false, unitIndex = 0) {
  if (!unit) return "";
  const deck = expandUnitDeck(unit);
  return `
    <section class="deck-preview">
      <div class="deck-head">
        <h4>机体卡组</h4>
        <span class="badge">${deck.length} 张</span>
      </div>
        ${renderExpandedDeck(deck, removalSet, { editable: !locked, unitIndex })}
    </section>
  `;
}

function renderUnitDeckPreview(unit) {
  if (!unit) return "";
  const deck = expandUnitDeck(unit);
  return `
    <section class="deck-preview unit-selection-deck">
      <div class="deck-head">
        <h4>全套卡组</h4>
        <span class="badge">${deck.length} 张</span>
      </div>
      ${renderExpandedDeck(deck, new Set(), { editable: false })}
    </section>
  `;
}

function renderExpandedDeck(deck, removalSet = new Set(), options = {}) {
  if (!deck.length) return `<div class="empty compact">暂无配置</div>`;
  const editable = Boolean(options.editable);
  const rows = deck
    .map((entry) => {
      const removed = removalSet.has(entry.key);
      const buttonAttrs = editable ? `button data-action="toggle-card-removal"` : "article";
      const closeTag = editable ? "button" : "article";
      return `
        <${buttonAttrs} class="deck-card ${editable ? "removable" : ""} ${removed ? "removed" : ""}" data-key="${escapeHtml(entry.key)}" data-unit-index="${Number(options.unitIndex || 0)}" title="${escapeHtml(entry.card?.name || entry.id)}">
          <img src="${cardImageAsset(entry.card?.card_picture)}" alt="">
        </${closeTag}>`;
    })
    .join("");
  return `
    <div class="deck-grid">
      ${rows}
    </div>
  `;
}

function renderFinalDeckForPlayer(player) {
  const unit = findUnit(player.selectedUnitId);
  const removals = new Set(asArray(player.deckRemovals));
  const deck = expandUnitDeck(unit).filter((entry) => !removals.has(entry.key));
  return renderExpandedDeck(deck, new Set(), { editable: false });
}

function renderRevealSelection(me) {
  const rows = asArray(state.room?.players)
    .map((player) => {
      const pilot = findPilot(player.selectedPilotId);
      const unit = findUnit(player.selectedUnitId);
      const removed = asArray(player.deckRemovals).length;
      return `
        <article class="revealed-player">
          <div class="revealed-head">
            ${player.avatar ? `<img class="avatar" src="${player.avatar}" alt="">` : `<span class="avatar"></span>`}
            <div>
              <strong>${escapeHtml(player.nickname)}</strong>
              <small>${escapeHtml(player.team || "-")} · ${escapeHtml(pilot?.pilot_name || "-")} / ${escapeHtml(unit?.unit_name || "-")} · 删除 ${removed} 张</small>
            </div>
            <span class="badge ${player.revealConfirmed ? "ready" : ""}">${player.revealConfirmed ? "已准备" : "查看中"}</span>
          </div>
          ${renderFinalDeckForPlayer(player)}
        </article>`;
    })
    .join("");
  return `
    <h3>阶段四：公开战斗卡组</h3>
    <p>所有玩家的最终战斗卡组已经公开。看完后点击“我已准备好”，全员准备后进入正式战斗。</p>
    <div class="revealed-list">${rows}</div>
    <div class="actions room-actions">
      <button class="primary" data-action="ready-battle" ${me?.revealConfirmed ? "disabled" : ""}>我已准备好</button>
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p id="roomStatus" class="status">${me?.revealConfirmed ? "已准备，等待其他玩家。" : ""}</p>
  `;
}

function renderBattlePlay(me) {
  const battle = state.room?.battle || {};
  if (battle.stage === "resolved") return renderBattleResolution(me);
  const owned = findOwnedBattleUnits();
  const self = owned[0] || null;
  if (state.room?.mode === "ai_sim" && !owned.length) return renderAiSimulationBattleView();
  const draft = getBattleDraft();
  const reserveSet = new Set(asArray(draft.reserveKeys));
  const usedKeys = new Set(
    asArray(draft.actions)
      .filter((action) => action?.cardKey)
      .map((action) => battleCardToken(action.actorUsername, action.cardKey))
  );
  const isRespawning = owned.length > 0 && owned.every((unit) => unit?.combat?.alive === false);
  return `
    <h3>正式战斗：第 ${battle.round || 1} 回合行动设定</h3>
    <p>本回合最多使用 ${owned.length} 张卡牌，一台机甲只能使用 1 张卡牌；冷却中或 EN 不足的卡牌不能设定。</p>
    <section class="battle-board">
      ${renderActionOrderBar()}
      ${renderBattlePlans()}
      ${renderBattleActionSlots(draft)}
      ${renderBattleMap()}
      ${renderBattleHand(owned, usedKeys, reserveSet)}
    </section>
    <div class="actions room-actions">
      <button class="ghost" data-action="reset-battle-draft">重新设定</button>
      <button class="primary" data-action="submit-actions" ${self?.actionConfirmed || isRespawning ? "disabled" : ""}>${isRespawning ? "复活等待中" : "行动设定完毕"}</button>
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p id="roomStatus" class="status">${isRespawning ? "待复活状态会自动跳过行动，不会阻塞其他玩家。" : self?.actionConfirmed ? "已提交行动，等待其他玩家。" : ""}</p>
  `;
}

function finalDeckComposition(player) {
  const unit = findUnit(player?.selectedUnitId);
  const removals = new Set(asArray(player?.deckRemovals));
  const counts = { attack: 0, defense: 0, utility: 0 };
  expandUnitDeck(unit)
    .filter((entry) => !removals.has(entry.key))
    .forEach((entry) => {
      if (counts[entry.type] !== undefined) counts[entry.type] += 1;
    });
  return counts;
}

function renderBattleVitals(self) {
  const unit = findUnit(self?.selectedUnitId);
  const deckComposition = finalDeckComposition(self);
  const stats = self?.stats || {};
  const { buffs, debuffs, statuses } = battleEffectLabels(self);
  const effectRows = [
    ...buffs.map((label) => `<span class="battle-effect buff">${escapeHtml(label)}</span>`),
    ...debuffs.map((label) => `<span class="battle-effect debuff">${escapeHtml(label)}</span>`),
    ...statuses.map((label) => `<span class="battle-effect respawn">${escapeHtml(label)}</span>`),
  ].join("");
  return `
    <div class="battle-vitals-bars">
      ${renderStatBar("HP", self?.combat?.hp, self?.combat?.maxHP, "hp")}
      ${renderStatBar("EN", self?.combat?.en, self?.combat?.maxEN, "en")}
      ${renderStatBar("SP", self?.combat?.sp, self?.combat?.maxSP, "sp")}
    </div>
    <div class="battle-vitals-meta">
      <span>装甲 ${escapeHtml(self?.combat?.effectiveArmor ?? self?.combat?.armor ?? "-")}</span>
      <span>牌组 <b class="deck-blue">${deckComposition.attack}</b>/<b class="deck-red">${deckComposition.defense}</b>/<b class="deck-green">${deckComposition.utility}</b></span>
      <span>KDA ${Number(stats.kills || 0)}/${Number(stats.deaths || 0)}/${Number(stats.assists || 0)}</span>
    </div>
    <div class="battle-effects-panel">${effectRows}</div>
  `;
}

function isPlayerInCloseCombat(player) {
  if (!Array.isArray(player?.combat?.coord)) return false;
  return asArray(state.room?.battle?.players).some(
    (other) =>
      other.username !== player.username &&
      other.team !== player.team &&
      other.combat?.alive !== false &&
      Array.isArray(other.combat?.coord) &&
      axialDistance(player.combat.coord, other.combat.coord) <= 1
  );
}

function battleEffectLabels(player) {
  const buffs = [];
  const debuffs = [];
  const statuses = [];
  const effects = player?.combat?.effects || {};
  if (player?.combat?.alive === false) statuses.push(`复活中（剩余${Math.max(0, Number(player.combat.respawnIn || 0))}回合）`);
  if (isPlayerInCloseCombat(player)) debuffs.push("近身");
  if (effects.sureHit) buffs.push("必中");
  if (Number(effects.evadeNextAttack || 0) > 0) buffs.push("必闪");
  if (Number(effects.nextAttackDamageMultiplier || 0) > 1) buffs.push("伤害提升");
  if (Number(effects.ironWall || 0) > 0) buffs.push("铁壁");
  if (Number(effects.guts || 0) > 0) buffs.push("底力");
  if (Number(effects.sniperRangeBonus || 0) > 0) buffs.push("狙击");
  if (Number(effects.accelMoveBonus || 0) > 0) buffs.push("加速");
  if (Number(effects.incomingDamageMultiplier || 0) > 1) debuffs.push("分析");
  return { buffs, debuffs, statuses };
}

function renderBattleEffectPanel(self) {
  const { buffs, debuffs, statuses } = battleEffectLabels(self);
  const rows = [
    ...buffs.map((label) => `<span class="battle-effect buff">${escapeHtml(label)}</span>`),
    ...debuffs.map((label) => `<span class="battle-effect debuff">${escapeHtml(label)}</span>`),
    ...statuses.map((label) => `<span class="battle-effect respawn">${escapeHtml(label)}</span>`),
  ].join("");
  return `<div class="battle-effects-panel">${rows || `<span class="battle-effect empty">无状态</span>`}</div>`;
}

function renderActionOrderBar(activeUsername = "") {
  const battle = state.room?.battle || {};
  const parts = asArray(battle.actionOrder).map((username) => {
    const player = asArray(battle.players).find((item) => item.username === username);
    const pilot = findPilot(player?.selectedPilotId);
    const unit = findUnit(player?.selectedUnitId);
    const active = username === activeUsername ? " active" : "";
    const teamClass = player?.team === "Team I" ? " team-i" : player?.team === "Team II" ? " team-ii" : "";
    return `
      <span class="order-card${teamClass}${active}" data-tooltip="order-deck" data-username="${escapeHtml(username)}">
        ${pilot?.face ? `<img class="order-pilot" src="${normalizeAsset(pilot.face)}" alt="">` : `<span class="order-pilot"></span>`}
        ${unit?.icon || unit?.appearance ? `<img class="order-unit" src="${normalizeAsset(unit.icon || unit.appearance)}" alt="">` : `<span class="order-unit"></span>`}
      </span>`;
  });
  return `<div class="battle-order"><strong>行动顺序</strong><span>${parts.join(`<i>→</i>`) || "尚未生成"}</span></div>`;
}

function renderOrderDeckTooltip(player) {
  if (!player) return `<div class="tooltip-empty">暂无卡组信息</div>`;
  const unit = findUnit(player.selectedUnitId);
  const removals = new Set(asArray(player.deckRemovals));
  const deck = expandUnitDeck(unit).filter((entry) => !removals.has(entry.key));
  const cards = deck
    .map((entry) => {
      const src = cardImageAsset(entry.card?.card_picture);
      const name = escapeHtml(entry.card?.name || entry.id);
      return `<img class="order-deck-popup-card" src="${src}" data-large-src="${src}" alt="${name}" title="${name}">`;
    })
    .join("");
  return `<div class="tooltip-deck-grid">${cards || `<span>暂无卡牌</span>`}</div>`;
}

function renderStatBar(label, value, maxValue, type) {
  const current = Number(value || 0);
  const max = Math.max(1, Number(maxValue || 0));
  const pct = Math.max(0, Math.min(100, (current / max) * 100));
  return `
    <div class="stat-bar ${type}">
      <div class="stat-bar-head"><strong>${label}</strong><span>${Math.round(current)}/${Math.round(max)}</span></div>
      <div class="stat-bar-track"><i style="width:${pct}%;"></i></div>
    </div>
  `;
}

function renderMiniStatBar(label, value, maxValue, type) {
  const current = Number(value || 0);
  const max = Math.max(1, Number(maxValue || 0));
  const pct = Math.max(0, Math.min(100, (current / max) * 100));
  return `
    <span class="mini-stat ${type}">
      <b>${label}</b>
      <i><em style="width:${pct}%;"></em></i>
      <strong>${Math.round(current)}/${Math.round(max)}</strong>
    </span>
  `;
}

function renderCompactBattleVitals(player) {
  return `
    <span class="battle-hand-unit-vitals">
      ${renderMiniStatBar("HP", player?.combat?.hp, player?.combat?.maxHP, "hp")}
      ${renderMiniStatBar("EN", player?.combat?.en, player?.combat?.maxEN, "en")}
      ${renderMiniStatBar("SP", player?.combat?.sp, player?.combat?.maxSP, "sp")}
    </span>
  `;
}

function renderBattlePlans() {
  const self = findBattleSelf();
  const players = asArray(state.room?.battle?.players)
    .filter((player) => player.username !== self?.username && player.team === self?.team)
    .slice(0, 5);
  const rows = players
    .map((player) => {
      const respawning = player.combat?.alive === false;
      const actions = asArray(player.actions).length
        ? asArray(player.actions).map((action, index) => `第${index + 1}轮 ${escapeHtml(battleCardLabel(findBattleEntryForAction(player, action)) || "-")} ${formatCoord(actionTargetCoord(action))}`).join(" · ")
        : "敌方行动隐藏";
      return `
        <div class="ally-row">
          <span class="avatar"></span>
          <div>
            <strong>${escapeHtml(player.nickname)}</strong>
            <small>${respawning ? `复活中（剩余${Math.max(0, Number(player.combat?.respawnIn || 0))}回合）` : actions}</small>
          </div>
          <span class="badge ${player.actionConfirmed || respawning ? "ready" : ""}">${respawning ? "待复活" : player.actionConfirmed ? "已设定" : "设定中"}</span>
        </div>`;
    })
    .join("");
  return `<section class="selection-status"><div class="settings-head"><h4>队友设定情况</h4><span class="badge">${players.length}/5</span></div><div class="ally-list">${rows || `<div class="empty compact">暂无队友</div>`}</div></section>`;
}

function findBattleEntryForAction(player, action) {
  return asArray(player.hand).find((entry) => entry.key === action?.cardKey) || { type: action?.cardKey?.split(":")[0], id: action?.cardKey?.split(":")[1] };
}

function renderBattleActionSlots(draft) {
  const owned = findOwnedBattleUnits();
  const actions = asArray(draft.actions);
  const emptySlotImage = "/assets/ui/empty_card_slot.png";
  return `
    <div class="battle-slots">
      ${actions
        .map((action, index) => {
          const actor = owned[index] || owned.find((unit) => unit.username === action.actorUsername) || owned[0];
          const spirits = getPilotSpirits(actor?.selectedPilotId);
          const currentSP = Number(actor?.combat?.sp || 0);
          action.actorUsername = actor?.username || action.actorUsername || "";
          const cardToken = action.cardKey ? battleCardToken(actor?.username || action.actorUsername, action.cardKey) : "";
          const entry = findHandEntryByKey(cardToken);
          const dragToken = entry ? battleCardToken(actor?.username || action.actorUsername || entry.actorUsername, entry.key) : "";
          const affordableSP = currentSP;
          const hasAffordableSpirit = spirits.some((spirit) => Number(spirit.SP_cost || 0) <= affordableSP);
          const emptySpiritLabel = hasAffordableSpirit || action.preSpiritId || action.postSpiritId ? "不使用精神" : "SP不足";
          return `
            <div class="battle-slot ${state.activeBattleTurn === index ? "active" : ""}" data-action="drop-battle-card" data-turn="${index}">
              <div class="spirit-controls">
                <div class="slot-actor-label">${escapeHtml(actor?.nickname || `机甲 ${index + 1}`)}</div>
                ${renderSpiritControlRow(action, index, actor, spirits, "pre", emptySpiritLabel, affordableSP)}
                ${renderSpiritControlRow(action, index, actor, spirits, "post", "不使用后置精神", affordableSP)}
              </div>
              <button class="battle-card-slot-button ${entry ? "filled" : "empty"}" data-action="select-battle-turn" data-turn="${index}">
                <img class="battle-slot-card" src="${entry ? battleCardImage(entry) : normalizeAsset(emptySlotImage)}" alt="" data-card-key="${escapeHtml(dragToken)}" draggable="${entry ? "true" : "false"}">
                <span>${escapeHtml(entry ? battleCardLabel(entry) : "空卡槽")}</span>
                ${entry ? "" : `<em class="slot-drop-hint">拖动卡牌到此处以使用</em>`}
                <small>目标 ${formatCoord(actionTargetCoord(action))}</small>
              </button>
            </div>`;
        })
        .join("")}
    </div>
  `;
}

function renderBattleHand(self, usedKeys, reserveSet) {
  const hand = asArray(self?.hand);
  const cooldowns = self?.cooldowns || {};
  const emptySlotImage = "/assets/ui/empty_card_slot.png";
  const rows = hand
    .map((entry) => {
      const cooling = Number(cooldowns[`${entry.type}:${entry.id}`] || 0) > 0;
      const used = usedKeys.has(entry.key);
      const reserved = reserveSet.has(entry.key);
      return `
        <article class="battle-hand-card ${used ? "used hand-empty" : ""} ${reserved ? "reserved" : ""}" data-card-key="${escapeHtml(entry.key)}" draggable="${cooling || reserved || used ? "false" : "true"}">
          <img src="${used ? normalizeAsset(emptySlotImage) : battleCardImage(entry)}" alt="">
          ${cooling ? `<span class="cooldown">冷却中</span>` : ""}
          ${used || (!cooling && !reserved) ? "" : `<div class="battle-card-actions"><button data-action="toggle-reserve-card" data-key="${escapeHtml(entry.key)}">${reserved ? "取消保留" : "保留"}</button></div>`}
        </article>`;
    })
    .join("");
  return `<section class="deck-preview" data-action="drop-card-back"><div class="deck-head"><img src="/assets/ui/draw_deck_pile.png" alt=""><span class="deck-count">${self?.battleDeckCount ?? 0}</span></div><div class="battle-hand-grid" data-action="drop-card-back">${rows || `<div class="empty compact">暂无手牌</div>`}</div></section>`;
}

function renderBattleHand(self, usedKeys, reserveSet) {
  const hand = asArray(self?.hand);
  const cooldowns = self?.cooldowns || {};
  const emptySlotImage = "/assets/ui/empty_card_slot.png";
  const rows = hand
    .map((entry) => {
      const cooling = Number(cooldowns[`${entry.type}:${entry.id}`] || 0) > 0;
      const used = usedKeys.has(entry.key);
      const reserved = reserveSet.has(entry.key);
      return `
        <article class="battle-hand-card ${used ? "used hand-empty" : ""} ${reserved ? "reserved" : ""}" data-card-key="${escapeHtml(entry.key)}" draggable="${cooling || reserved || used ? "false" : "true"}">
          <img src="${used ? normalizeAsset(emptySlotImage) : battleCardImage(entry)}" alt="">
          ${cooling ? `<span class="cooldown">冷却中</span>` : ""}
          ${used ? "" : `<div class="battle-card-actions"><button data-action="toggle-reserve-card" data-key="${escapeHtml(entry.key)}">${reserved ? "取消保留" : "保留"}</button></div>`}
        </article>`;
    })
    .join("");
  return `<section class="deck-preview" data-action="drop-card-back"><div class="deck-head"><img src="/assets/ui/draw_deck_pile.png" alt=""><span class="deck-count">${self?.battleDeckCount ?? 0}</span></div><div class="battle-hand-grid" data-action="drop-card-back">${rows || `<div class="empty compact">暂无手牌</div>`}</div></section>`;
}

function renderBattleHand(units, usedKeys, reserveSet) {
  const emptySlotImage = "/assets/ui/empty_card_slot.png";
  const rows = asArray(units)
    .map((unit) => {
      const cooldowns = unit?.cooldowns || {};
      const cards = asArray(unit?.hand)
        .map((entry) => {
      const token = battleCardToken(unit.username, entry.key);
      const cooling = Number(cooldowns[entry.key] || cooldowns[`${entry.type}:${entry.id}`] || 0) > 0;
      const used = usedKeys.has(token);
      const reserved = reserveSet.has(entry.key);
      return `
        <article class="battle-hand-card ${used ? "used hand-empty" : ""} ${reserved ? "reserved" : ""}" data-card-key="${escapeHtml(token)}" data-actor-username="${escapeHtml(unit.username)}" draggable="${cooling || reserved || used ? "false" : "true"}">
          <img src="${used ? normalizeAsset(emptySlotImage) : battleCardImage(entry)}" alt="">
          ${cooling ? `<span class="cooldown">冷却中</span>` : ""}
        </article>`;
    })
        .join("");
      return `<div class="battle-hand-unit"><strong>${escapeHtml(unit.nickname)}</strong><div class="battle-hand-grid" data-action="drop-card-back">${cards || `<div class="empty compact">暂无卡牌</div>`}</div></div>`;
    })
    .join("");
  return `<section class="deck-preview" data-action="drop-card-back"><div class="deck-head"><img src="/assets/ui/draw_deck_pile.png" alt=""><span class="deck-count">${asArray(units).length} 台机甲</span></div>${rows || `<div class="empty compact">暂无手牌</div>`}</section>`;
}

function renderBattleHand(units, usedKeys, reserveSet) {
  const emptySlotImage = "/assets/ui/empty_card_slot.png";
  const owned = asArray(units);
  const activeUnit =
    owned.find((unit) => unit.username === state.selectedBattleHandActor) ||
    owned.find((unit) => unit.combat?.alive !== false) ||
    owned[0];
  if (activeUnit && state.selectedBattleHandActor !== activeUnit.username) {
    state.selectedBattleHandActor = activeUnit.username;
  }
  const unitTabs = owned
    .map((unit, index) => {
      const active = unit.username === activeUnit?.username ? " active" : "";
      const pilot = findPilot(unit.selectedPilotId);
      const unitData = findUnit(unit.selectedUnitId);
      return `
        <button class="battle-hand-unit-tab${active}" data-action="select-battle-hand-unit" data-actor-username="${escapeHtml(unit.username)}">
          <span class="battle-hand-unit-images">
            ${pilot?.face ? `<img src="${normalizeAsset(pilot.face)}" alt="">` : `<i></i>`}
            ${unitData?.icon || unitData?.appearance ? `<img src="${normalizeAsset(unitData.icon || unitData.appearance)}" alt="">` : `<i></i>`}
          </span>
          <span class="battle-hand-unit-name">${escapeHtml(unit.nickname || `机甲 ${index + 1}`)}</span>
          ${renderCompactBattleVitals(unit)}
        </button>`;
    })
    .join("");
  const cooldowns = activeUnit?.cooldowns || {};
  const cards = asArray(activeUnit?.hand)
    .map((entry) => {
      const token = battleCardToken(activeUnit.username, entry.key);
      const cooling = Number(cooldowns[entry.key] || cooldowns[`${entry.type}:${entry.id}`] || 0) > 0;
      const used = usedKeys.has(token);
      const reserved = reserveSet.has(entry.key);
      return `
        <article class="battle-hand-card ${used ? "used hand-empty" : ""} ${reserved ? "reserved" : ""}" data-card-key="${escapeHtml(token)}" data-actor-username="${escapeHtml(activeUnit.username)}" draggable="${cooling || reserved || used ? "false" : "true"}">
          <img src="${used ? normalizeAsset(emptySlotImage) : battleCardImage(entry)}" alt="">
          ${cooling ? `<span class="cooldown">冷却中</span>` : ""}
        </article>`;
    })
    .join("");
  return `<section class="deck-preview battle-hand-panel" data-action="drop-card-back"><div class="battle-hand-unit-picker">${unitTabs || `<div class="empty compact">暂无机甲</div>`}</div><div class="battle-hand-grid" data-action="drop-card-back">${cards || `<div class="empty compact">暂无卡牌</div>`}</div></section>`;
}

function renderBattleMap(showDraftTargets = true) {
  const map = findMap(state.room?.mapId);
  const draft = getBattleDraft();
  const target = showDraftTargets ? draft.actions?.[state.activeBattleTurn]?.target : null;
  return `
    <section class="battle-map-panel">
      <div class="settings-head"><h4>战术地图</h4><span class="badge">滚轮缩放 · 点击格子</span></div>
      <div class="battle-map-viewport" data-action="map-wheel">
        <div class="battle-map-stack" data-action="pick-map-point" style="${battleMapStackStyle()}">
          <img class="battle-map-thumb" src="${normalizeMapImage(map?.terrain_dark_image || map?.terrain_light_image)}" alt="">
          ${renderBattleVisionLayer(map)}
          <div class="battle-fog-tiles" aria-hidden="true">${renderBattleFogTiles()}</div>
          <div class="battle-flame-tiles" aria-hidden="true">${renderBattleFlameTiles()}</div>
          ${renderBattleMapMarkers(target, showDraftTargets)}
          <div class="battle-animation-layer" aria-hidden="true"></div>
          <span class="map-hover-target" aria-hidden="true"></span>
        </div>
      </div>
      <div class="coord-pad">
        ${sampleBattleCoords()
          .map((coord) => `<button data-action="pick-target" data-q="${coord[0]}" data-r="${coord[1]}">${coord[0]},${coord[1]}</button>`)
          .join("")}
      </div>
    </section>
  `;
}

function renderBattleMapMarkers(target, showDraftTargets = true) {
  const self = findBattleSelf();
  const hex = battleHexSizePercent();
  const playerMarkers = asArray(state.room?.battle?.players)
    .filter(
      (player) =>
        currentReplayCoord(player) &&
        player.combat?.alive !== false &&
        (player.team === self?.team || isCoordVisible(currentReplayCoord(player)))
    )
    .map((player) => {
      const coord = currentReplayCoord(player);
      const pos = battleCoordToPercent(coord);
      const unit = findUnit(player.selectedUnitId);
      return `
        <button class="map-token unit-token ${player.team === "Team I" ? "team-i" : "team-ii"}" data-action="pick-target" data-q="${coord[0]}" data-r="${coord[1]}" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width}%; --hex-height:${hex.height}%;" title="${escapeHtml(player.nickname)} ${formatCoord(coord)}">
          <img src="${normalizeAsset(unit?.icon || unit?.appearance)}" alt="">
        </button>`;
    })
    .join("");
  const baseMarkers = Object.values(state.room?.bases || {})
    .map((base) => {
      const pos = battleCoordToPercent(base.coord);
      return `
        <button class="map-token base-token ${base.team === "Team I" ? "team-i" : "team-ii"}" data-action="pick-target" data-q="${base.coord[0]}" data-r="${base.coord[1]}" style="left:${pos.left}%; top:${pos.top}%;" title="${escapeHtml(base.team)} 基地 ${formatCoord(base.coord)}">
        </button>`;
    })
    .join("");
  const targetMarker = Array.isArray(target)
    ? (() => {
        const pos = battleCoordToPercent(target);
        return `<span class="map-target" style="left:${pos.left}%; top:${pos.top}%;">目标</span>`;
      })()
    : "";
  return `${baseMarkers}${playerMarkers}${targetMarker}`;
}

function renderBattleMapMarkers(target, showDraftTargets = true) {
  const self = findBattleSelf();
  const hex = battleHexSizePercent();
  const playerMarkers = asArray(state.room?.battle?.players)
    .filter(
      (player) =>
        currentReplayCoord(player) &&
        player.combat?.alive !== false &&
        (player.team === self?.team || isCoordVisible(currentReplayCoord(player)))
    )
    .map((player) => {
      const coord = currentReplayCoord(player);
      const pos = battleCoordToPercent(coord);
      const unit = findUnit(player.selectedUnitId);
      return `
        <button class="map-token unit-token ${player.team === "Team I" ? "team-i" : "team-ii"}" data-action="pick-target" data-q="${coord[0]}" data-r="${coord[1]}" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width}%; --hex-height:${hex.height}%;" title="${escapeHtml(player.nickname)} ${formatCoord(coord)}">
          <img src="${normalizeAsset(unit?.icon || unit?.appearance)}" alt="">
        </button>`;
    })
    .join("");
  const baseMarkers = Object.values(state.room?.bases || {})
    .map((base) => {
      const pos = battleCoordToPercent(base.coord);
      const icon = base.team === "Team I" ? "icon_images/base_blue.png" : "icon_images/base_red.png";
      return `
        <button class="map-token base-token ${base.team === "Team I" ? "team-i" : "team-ii"}" data-action="pick-target" data-q="${base.coord[0]}" data-r="${base.coord[1]}" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width}%; --hex-height:${hex.height}%;" title="${escapeHtml(base.team)} 基地 ${formatCoord(base.coord)}">
          <img src="${normalizeAsset(icon)}" alt="">
        </button>`;
    })
    .join("");
  const targetMarker = Array.isArray(target)
    ? (() => {
        const pos = battleCoordToPercent(target);
        return `<span class="map-target" style="left:${pos.left}%; top:${pos.top}%;">目标</span>`;
      })()
    : "";
  return `${baseMarkers}${playerMarkers}${targetMarker}`;
}

function renderBattleMapMarkers(target, showDraftTargets = true) {
  const self = findBattleSelf();
  const hex = battleHexSizePercent();
  const visiblePlayers = asArray(state.room?.battle?.players)
    .filter((player) => {
      const coord = currentReplayCoord(player);
      return coord && currentReplayAlive(player) && (player.team === self?.team || isCoordVisible(coord));
    });
  const overlapTotals = visiblePlayers.reduce((counts, player) => {
    const key = coordKey(currentReplayCoord(player));
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
  const overlapIndexes = new Map();
  const playerMarkers = visiblePlayers
    .map((player) => {
      const coord = currentReplayCoord(player);
      const pos = battleCoordToPercent(coord);
      const unit = findUnit(player.selectedUnitId);
      const key = coordKey(coord);
      const overlapIndex = overlapIndexes.get(key) || 0;
      overlapIndexes.set(key, overlapIndex + 1);
      const overlapTotal = overlapTotals.get(key) || 1;
      const angle = overlapTotal > 1 ? (Math.PI * 2 * overlapIndex) / overlapTotal - Math.PI / 2 : 0;
      const radius = overlapTotal > 1 ? Math.min(hex.width, hex.height) * 0.24 : 0;
      const markerLeft = pos.left + Math.cos(angle) * radius;
      const markerTop = pos.top + Math.sin(angle) * radius;
      const selfClass = player.username === self?.username ? " self" : "";
      const relationClass = player.username === self?.username ? " relation-self" : player.team === self?.team ? " relation-ally" : " relation-enemy";
      return `
        <button class="map-token unit-token${selfClass}${relationClass} ${player.team === "Team I" ? "team-i" : "team-ii"}" data-action="pick-target" data-q="${coord[0]}" data-r="${coord[1]}" data-username="${escapeHtml(player.username)}" style="left:${markerLeft}%; top:${markerTop}%; --hex-width:${hex.width}%; --hex-height:${hex.height}%;" title="${escapeHtml(player.nickname)} ${formatCoord(coord)}">
          <img src="${normalizeAsset(unit?.icon || unit?.appearance)}" alt="">
        </button>`;
    })
    .join("");
  const baseMarkers = Object.values(state.room?.bases || {})
    .map((base) => {
      const pos = battleCoordToPercent(base.coord);
      const icon = base.team === "Team I" ? "icon_images/base_blue.png" : "icon_images/base_red.png";
      return `
        <button class="map-token base-token ${base.team === "Team I" ? "team-i" : "team-ii"}" data-action="pick-target" data-q="${base.coord[0]}" data-r="${base.coord[1]}" data-base-team="${escapeHtml(base.team)}" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width}%; --hex-height:${hex.height}%;" title="${escapeHtml(base.team)} 基地 ${formatCoord(base.coord)}">
          <img src="${normalizeAsset(icon)}" alt="">
        </button>`;
    })
    .join("");
  const treasureMarkers = asArray(state.room?.mapTreasures)
    .filter((item) => Array.isArray(item.coord) && isCoordVisible(item.coord))
    .map((item) => {
      const pos = battleCoordToPercent(item.coord);
      return `
        <button class="map-token treasure-token" data-action="pick-target" data-q="${item.coord[0]}" data-r="${item.coord[1]}" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width}%; --hex-height:${hex.height}%;" title="${escapeHtml(item.name || "补给品")} ${formatCoord(item.coord)}">
          <span>EN</span>
        </button>`;
    })
    .join("");
  const targetsByCoord = new Map();
  if (showDraftTargets) {
    asArray(getBattleDraft().actions).forEach((action, index) => {
      const finalTarget = actionTargetCoord(action);
      if (!Array.isArray(finalTarget)) return;
      const key = coordKey(finalTarget);
      const item = targetsByCoord.get(key) || { coord: finalTarget, turns: [] };
      item.turns.push({ number: index + 1, type: battleActionType(action) });
      targetsByCoord.set(key, item);
    });
    if (Array.isArray(target) && !targetsByCoord.has(coordKey(target))) {
      targetsByCoord.set(coordKey(target), {
        coord: target,
        turns: [{ number: state.activeBattleTurn + 1, type: "unknown" }],
      });
    }
  }
  const targetMarker = Array.from(targetsByCoord.values())
    .map(({ coord, turns }) => {
      const pos = battleCoordToPercent(coord);
      const active = turns.some((turn) => turn.number === state.activeBattleTurn + 1) ? " active" : "";
      const sizeClass = turns.length >= 3 ? " triple" : turns.length >= 2 ? " double" : "";
      const label = turns.map((turn) => turn.number).join("/");
      const numbers = turns
        .map((turn, index) => `${index ? `<span class="map-target-separator">/</span>` : ""}<span class="map-target-number ${escapeHtml(turn.type)}">${turn.number}</span>`)
        .join("");
      return `<span class="map-target${active}${sizeClass}" style="left:${pos.left}%; top:${pos.top}%; --hex-width:${hex.width}%; --hex-height:${hex.height}%;" title="第 ${label} 轮目标">${numbers}</span>`;
    })
    .join("");
  return `${baseMarkers}${treasureMarkers}${playerMarkers}${targetMarker}`;
}

function currentReplayCoord(player) {
  const coord = player?.combat?.coord;
  const battle = state.room?.battle || {};
  const events = asArray(battle.resolutionEvents);
  if (battle.stage !== "resolved" || !events.length || !Array.isArray(coord)) return coord;
  let replayCoord = [...coord];
  const currentIndex =
    state.resolutionPlayback.key === resolutionPlaybackKey()
      ? Math.min(state.resolutionPlayback.index || 0, events.length)
      : 0;
  for (let i = events.length - 1; i >= currentIndex; i -= 1) {
    for (const effect of asArray(events[i]?.animation?.effects)) {
      if (effect.kind === "move" && effect.username === player.username && Array.isArray(effect.from)) {
        replayCoord = [...effect.from];
      }
    }
  }
  return replayCoord;
}

function currentReplayAlive(player) {
  if (!player?.combat) return false;
  const battle = state.room?.battle || {};
  const events = asArray(battle.resolutionEvents);
  let alive = player.combat.alive !== false;
  if (battle.stage !== "resolved" || !events.length) return alive;
  const currentIndex =
    state.resolutionPlayback.key === resolutionPlaybackKey()
      ? Math.min(state.resolutionPlayback.index || 0, events.length)
      : 0;
  for (let i = events.length - 1; i >= currentIndex; i -= 1) {
    for (const effect of asArray(events[i]?.animation?.effects)) {
      if (effect.kind === "destroyed" && effect.username === player.username) {
        alive = true;
      }
    }
  }
  return alive;
}

function sampleBattleCoords() {
  const players = asArray(state.room?.battle?.players);
  const coords = [];
  for (const player of players) {
    if (player.combat?.coord) coords.push(player.combat.coord);
  }
  for (const base of Object.values(state.room?.bases || {})) {
    if (base.coord) coords.push(base.coord);
  }
  return coords.filter((coord, index) => coords.findIndex((other) => String(other) === String(coord)) === index);
}

function renderAiSimulationStats() {
  if (state.room?.mode !== "ai_sim") return "";
  const rows = asArray(state.room?.battle?.players)
    .map((player) => {
      const pilot = findPilot(player.selectedPilotId);
      const unit = findUnit(player.selectedUnitId);
      const stats = player.stats || {};
      return `
        <div class="ai-sim-stat-row ${player.team === "Team I" ? "team-i" : "team-ii"}">
          <strong>${escapeHtml(player.team)} / ${escapeHtml(pilot?.pilot_name || "-")} / ${escapeHtml(unit?.unit_name || "-")}</strong>
          <span>HP ${player.combat?.hp ?? "-"}/${player.combat?.maxHP ?? "-"}</span>
          <span>KDA ${Number(stats.kills || 0)}/${Number(stats.deaths || 0)}/${Number(stats.assists || 0)}</span>
          <span>${player.combat?.alive === false ? `复活中 ${Math.max(0, Number(player.combat?.respawnIn || 0))}` : "存活"}</span>
        </div>`;
    })
    .join("");
  return `
    <section class="ai-sim-stats">
      <div class="settings-head"><h4>AI模拟统计</h4><span class="badge">第 ${state.room?.battle?.round || 1} 回合</span></div>
      ${rows || `<div class="empty compact">暂无统计</div>`}
    </section>`;
}

function renderAiSimulationBattleView() {
  const battle = state.room?.battle || {};
  return `
    <h3>AI模拟测试：第 ${battle.round || 1} 回合</h3>
    <section class="battle-board resolution-board">
      ${renderActionOrderBar()}
      ${renderBattleMap(false)}
      ${renderAiSimulationStats()}
      <section class="battle-log resolution-log">
        ${asArray(battle.logs).slice(0, 18).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      </section>
    </section>
    <div class="actions room-actions">
      <button class="ghost" data-action="leave">离开模拟</button>
    </div>
    <p id="roomStatus" class="status">AI 正在自动设定行动。</p>`;
}

function renderBattleResolution(me) {
  const battle = state.room?.battle || {};
  const self = findBattleSelf();
  const events = asArray(battle.resolutionEvents);
  const index = Math.min(state.resolutionPlayback.index || 0, Math.max(0, events.length - 1));
  const event = events[index] || null;
  const done = !events.length || state.resolutionPlayback.skipped || (state.resolutionPlayback.index || 0) >= events.length;
  const battleEnded = Boolean(battle.winner);
  return `
    <h3>第 ${battle.round || 1} 回合战斗结算</h3>
    ${renderVictoryBanner(battle.winner)}
    <section class="battle-board resolution-board">
      ${renderActionOrderBar(event?.publicAction?.username || "")}
      ${renderBattleMap(false)}
      ${renderResolutionActionPanel(event, index, events.length, done)}
      ${renderAiSimulationStats()}
      <section class="battle-log resolution-log">
        ${asArray(battle.logs).slice(0, 18).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      </section>
    </section>
    <div class="actions room-actions">
      <button class="ghost" data-action="skip-resolution" ${done ? "disabled" : ""}>跳过动画</button>
      <button class="primary" data-action="next-round" ${done && !battleEnded && !self?.nextRoundConfirmed ? "" : "disabled"}>${battleEnded ? "战斗结束" : self?.nextRoundConfirmed ? "等待其他玩家" : "进入下一回合"}</button>
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p id="roomStatus" class="status ${battleEnded ? "ok" : ""}">${battleEnded ? "战斗已经结束，本回合结算信息仍保留在这里。" : self?.nextRoundConfirmed ? "已确认进入下一回合，等待其他玩家。" : done ? "结算动画播放完毕。" : "正在播放结算动画。"}</p>
  `;
}

function renderSpiritControlRow(action, turn, actor, spirits, timing, emptyLabel, affordableSP) {
  const spiritField = timing === "post" ? "postSpiritId" : "preSpiritId";
  const targetField = timing === "post" ? "postSpiritTargetUsername" : "preSpiritTargetUsername";
  const selectedSpiritId = String(action?.[spiritField] || "");
  const targetMode = spiritTargetMode(selectedSpiritId);
  const targetOptions = targetMode ? spiritTargetOptions(selectedSpiritId, actor) : [];
  const selectedTarget = targetMode ? defaultSpiritTargetUsername(selectedSpiritId, action?.[targetField] || "", actor) : "";
  const rowClass = targetMode ? " has-target" : "";
  return `
    <div class="spirit-row${rowClass}">
      <select data-action="select-${timing}-spirit" data-turn="${turn}">
        <option value="">${emptyLabel}</option>
        ${spirits
          .map((spirit) => {
            const selected = selectedSpiritId === String(spirit.spirit_ID);
            const disabled = !selected && Number(spirit.SP_cost || 0) > affordableSP;
            const prefix = timing === "post" ? "后置" : "前置";
            return `<option value="${escapeHtml(spirit.spirit_ID)}" ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}>${prefix} ${escapeHtml(spirit.name)} / SP ${escapeHtml(spirit.SP_cost || 0)}</option>`;
          })
          .join("")}
      </select>
      ${
        targetMode
          ? `<select data-action="select-spirit-target" data-turn="${turn}" data-timing="${timing}">
              ${targetOptions
                .map((player) => `<option value="${escapeHtml(player.username)}" ${player.username === selectedTarget ? "selected" : ""}>${escapeHtml(player.nickname || battlePlayerOptionLabel(player))}</option>`)
                .join("")}
            </select>`
          : ""
      }
    </div>
  `;
}

function renderVictoryBanner(winner) {
  if (!winner) return "";
  const victoryText =
    winner === "Team I"
      ? "Team I Win!"
      : winner === "Team II"
        ? "Team II Win!"
        : "The match ended in a draw";
  const victoryClass = winner === "Team I" ? "team-i" : winner === "Team II" ? "team-ii" : "draw";
  return `<div class="victory-banner ${victoryClass}">${escapeHtml(victoryText)}</div>`;
}

function renderResolutionActionPanel(event, index, total, done) {
  const action = event?.publicAction || {};
  const pilotFace = action.pilotFace || "";
  const unitIcon = action.unitIcon || "";
  const cardImage = action.cardImage || "";
  const typeLabel = action.cardType === "attack" ? "攻击" : action.cardType === "defense" ? "防御" : action.cardType === "utility" ? "通用" : action.cardType === "spirit" ? "精神" : "行动";
  return `
    <section class="resolution-action-panel ${done ? "" : "cue"}">
      <div class="settings-head">
        <h4>${done ? "结算完成" : "当前行动"}</h4>
        <span class="badge">${total ? `${Math.min(index + 1, total)} / ${total}` : "0 / 0"}</span>
      </div>
      <div class="resolution-actor">
        ${pilotFace ? `<img class="resolution-pilot" src="${normalizeAsset(pilotFace)}" alt="">` : `<span class="resolution-pilot"></span>`}
        <div>
          <strong>${escapeHtml(action.nickname || "-")}</strong>
          <small>${escapeHtml(action.team || "")} · 第 ${event?.turn || action.turn || "-"} 轮</small>
        </div>
        ${unitIcon ? `<img class="resolution-unit" src="${normalizeAsset(unitIcon)}" alt="">` : `<span class="resolution-unit"></span>`}
      </div>
      <div class="resolution-card ${escapeHtml(action.cardType || "")}">
        ${cardImage ? `<img src="${normalizeAsset(cardImage)}" alt="">` : `<div class="resolution-card-placeholder">${escapeHtml(typeLabel)}</div>`}
      </div>
    </section>
  `;
}

function renderBattleRoster() {
  const rows = asArray(state.room?.battle?.players)
    .map((player) => `<div class="ally-row"><span class="avatar"></span><div><strong>${escapeHtml(player.nickname)}</strong><small>${escapeHtml(player.team)} · HP ${player.combat?.hp ?? "-"} · EN ${player.combat?.en ?? "-"} · ${formatCoord(player.combat?.coord)}</small></div><span class="badge ${player.combat?.alive === false ? "" : "ready"}">${player.combat?.alive === false ? "待复活" : "存活"}</span></div>`)
    .join("");
  return `<section class="selection-status"><div class="settings-head"><h4>战场状态</h4><span class="badge">公开</span></div><div class="ally-list">${rows}</div></section>`;
}

function renderBattleEnded(me) {
  const winner = state.room?.battle?.winner || "未知队伍";
  return `
    <h3>战斗结束</h3>
    ${renderVictoryBanner(winner)}
    ${renderBattleRoster()}
    <div class="actions room-actions">
      <button class="ghost" data-action="leave">离开房间</button>
    </div>
    <p id="roomStatus" class="status ok">正式战斗已结束。</p>
  `;
}

function resolutionPlaybackKey() {
  const battle = state.room?.battle || {};
  return `${state.room?.id || ""}:${battle.round || 0}:${asArray(battle.resolutionEvents).map((event) => event.id).join("|")}`;
}

function startResolutionPlayback() {
  const battle = state.room?.battle || {};
  const events = asArray(battle.resolutionEvents);
  const isResolved = state.view === "room" && state.room?.phase === "battle" && battle.stage === "resolved";
  if (state.resolutionPlayback.timer) {
    clearTimeout(state.resolutionPlayback.timer);
    state.resolutionPlayback.timer = null;
  }
  if (!isResolved || !events.length) return;
  const key = resolutionPlaybackKey();
  if (state.resolutionPlayback.key !== key) {
    state.resolutionPlayback = { key, index: 0, timer: null, skipped: false };
  }
  if (state.resolutionPlayback.skipped || state.resolutionPlayback.index >= events.length) return;
  const event = events[state.resolutionPlayback.index];
  state.resolutionPlayback.timer = setTimeout(() => {
    playResolutionEvent(event);
    state.resolutionPlayback.timer = setTimeout(() => {
      state.resolutionPlayback.index += 1;
      renderRoomPreservingScroll();
    }, RESOLUTION_ANIM_MS);
  }, RESOLUTION_CUE_MS);
}

function centerResolutionMapOnSelf() {
  const battle = state.room?.battle || {};
  const isResolved = state.view === "room" && state.room?.phase === "battle" && battle.stage === "resolved";
  if (!isResolved) {
    state.resolutionCenteredKey = "";
    return;
  }
  const key = resolutionPlaybackKey();
  if (state.resolutionCenteredKey === key) return;
  state.resolutionCenteredKey = key;
  const self = findBattleSelf();
  const coord = currentReplayCoord(self) || self?.combat?.coord;
  if (!Array.isArray(coord)) return;
  centerBattleMapOnCoord(coord);
}

function centerBattleMapOnCoord(coord) {
  if (!Array.isArray(coord)) return;
  const center = () => {
    const viewport = document.querySelector("[data-action='map-wheel']");
    const stack = viewport?.querySelector(".battle-map-stack");
    if (!viewport || !stack) return;
    const pos = battleCoordToPercent(coord);
    viewport.scrollLeft = stack.offsetLeft + (pos.left / 100) * stack.offsetWidth - viewport.clientWidth / 2;
    viewport.scrollTop = stack.offsetTop + (pos.top / 100) * stack.offsetHeight - viewport.clientHeight / 2;
  };
  requestAnimationFrame(center);
  setTimeout(center, 80);
  setTimeout(center, 260);
}

function playRespawnAnimation(coord, unitIcon = "") {
  const pos = percentForCoord(coord);
  if (!pos) return;
  playSfx("spirit");
  drawTargetEffect(coord, "anim-respawn-ring", "", { durationMs: 1000 });
  addAnimationElement("anim-respawn-text", `left:${pos.left}%; top:${pos.top - 3.2}%;`, "Respawn", 1250);
  if (unitIcon) {
    addAnimationImage("anim-respawn-unit", unitIcon, `left:${pos.left}%; top:${pos.top}%;`);
  }
}

function maybePlaySelfRespawnAnimation() {
  const self = findBattleSelf();
  const selfUnit = self ? findUnit(self.selectedUnitId) : null;
  const current = {
    roomId: state.room?.id || "",
    round: state.room?.battle?.round || 0,
    phase: state.room?.phase || "",
    stage: state.room?.battle?.stage || "",
    alive: self?.combat?.alive !== false,
    coord: Array.isArray(self?.combat?.coord) ? [...self.combat.coord] : null,
    unitIcon: selfUnit?.icon || selfUnit?.appearance || "",
  };
  const previous = state.lastSelfCombatSnapshot;
  state.lastSelfCombatSnapshot = current;
  const key = `${current.roomId}:${current.round}:${coordKey(current.coord)}:respawn`;
  if (
    previous?.roomId === current.roomId &&
    previous.phase === "battle" &&
    previous.alive === false &&
    current.alive &&
    current.phase === "battle" &&
    current.stage === "planning" &&
    Array.isArray(current.coord) &&
    state.respawnAnimationKey !== key
  ) {
    state.respawnAnimationKey = key;
    centerBattleMapOnCoord(current.coord);
    setTimeout(() => playRespawnAnimation(current.coord, current.unitIcon), 180);
  }
}

function skipResolutionPlayback() {
  if (state.resolutionPlayback.timer) clearTimeout(state.resolutionPlayback.timer);
  state.resolutionPlayback.timer = null;
  state.resolutionPlayback.skipped = true;
  state.resolutionPlayback.index = asArray(state.room?.battle?.resolutionEvents).length;
  renderRoomPreservingScroll();
}

function addAnimationElement(className, style = "", text = "", lifeMs = RESOLUTION_ANIM_MS + 250) {
  const layer = document.querySelector(".battle-animation-layer");
  if (!layer) return null;
  const el = document.createElement("span");
  el.className = className;
  if (style) el.setAttribute("style", style);
  el.textContent = text;
  layer.appendChild(el);
  setTimeout(() => el.remove(), lifeMs);
  return el;
}

function addAnimationImage(className, src, style = "") {
  const layer = document.querySelector(".battle-animation-layer");
  if (!layer || !src) return null;
  const img = document.createElement("img");
  img.className = className;
  img.src = normalizeAsset(src);
  if (style) img.setAttribute("style", style);
  layer.appendChild(img);
  setTimeout(() => img.remove(), RESOLUTION_ANIM_MS + 250);
  return img;
}

function percentForCoord(coord) {
  return Array.isArray(coord) ? battleCoordToPercent(coord) : null;
}

function drawResolutionBeam(fromCoord, toCoord, mode, type, options = {}) {
  const from = percentForCoord(fromCoord);
  const to = percentForCoord(toCoord);
  let a = from;
  let b = to;
  if (!a && b) a = { left: b.left - 18, top: b.top - 8 };
  if (a && !b) b = { left: a.left + 18, top: a.top + 8 };
  if (!a || !b || mode === "hidden") return;
  const dx = b.left - a.left;
  const dy = b.top - a.top;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const duration = Math.max(1, Number(options.durationMs || RESOLUTION_ANIM_MS));
  const delay = Math.max(0, Number(options.delayMs || 0));
  addAnimationElement(
    `anim-beam ${type || ""} ${mode || ""}`,
    `left:${a.left}%; top:${a.top}%; width:${length}%; transform:rotate(${angle}deg); animation:animBeam ${duration}ms ease-out ${delay}ms forwards;`,
    "",
    duration + delay + 250
  );
}

function animationType(value) {
  return String(value || "").trim();
}

function offsetPoint(point, dx = 0, dy = 0) {
  if (!point) return null;
  return { left: point.left + dx, top: point.top + dy };
}

function drawTimedBeam(fromCoord, toCoord, className, options = {}) {
  const from = percentForCoord(fromCoord);
  const to = percentForCoord(toCoord);
  if (!from || !to) return;
  const start = offsetPoint(from, options.fromDx || 0, options.fromDy || 0);
  const end = offsetPoint(to, options.toDx || 0, options.toDy || 0);
  const dx = end.left - start.left;
  const dy = end.top - start.top;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const duration = Math.max(1, Number(options.durationMs || 280));
  const delay = Math.max(0, Number(options.delayMs || 0));
  addAnimationElement(
    className,
    `left:${start.left}%; top:${start.top}%; width:${length}%; transform:rotate(${angle}deg); animation-duration:${duration}ms; animation-delay:${delay}ms;`,
    "",
    duration + delay + 250
  );
}

function drawProjectile(fromCoord, toCoord, className, options = {}) {
  const from = percentForCoord(fromCoord);
  const to = percentForCoord(toCoord);
  if (!from || !to) return;
  const start = offsetPoint(from, options.fromDx || 0, options.fromDy || 0);
  const end = offsetPoint(to, options.toDx || 0, options.toDy || 0);
  const dx = end.left - start.left;
  const dy = end.top - start.top;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const duration = Math.max(1, Number(options.durationMs || 760));
  const delay = Math.max(0, Number(options.delayMs || 0));
  addAnimationElement(
    className,
    `left:${start.left}%; top:${start.top}%; --to-left:${end.left}%; --to-top:${end.top}%; --travel-rot:${angle}deg; animation-duration:${duration}ms; animation-delay:${delay}ms;`,
    "",
    duration + delay + 250
  );
}

function drawTargetEffect(coord, className, text = "", options = {}) {
  const pos = percentForCoord(coord);
  if (!pos) return;
  const duration = Math.max(1, Number(options.durationMs || RESOLUTION_ANIM_MS));
  const delay = Math.max(0, Number(options.delayMs || 0));
  addAnimationElement(
    className,
    `left:${pos.left}%; top:${pos.top}%; animation-duration:${duration}ms; animation-delay:${delay}ms;`,
    text,
    duration + delay + 250
  );
}

function playAttackAnimation(kind, actorCoord, targetCoord, voice = "") {
  if (!actorCoord || !targetCoord) return false;
  switch (animationType(kind)) {
    case "剑砍":
      playCardVoice(voice, "sword-slash");
      drawTargetEffect(targetCoord, "anim-melee-slash sword", "", { durationMs: 900 });
      return true;
    case "斧砍":
      playCardVoice(voice, "axe-slash");
      drawTargetEffect(targetCoord, "anim-melee-slash axe", "", { durationMs: 980 });
      return true;
    case "飞弹":
      playCardVoice(voice, "missile", { layerFallback: true });
      drawProjectile(actorCoord, targetCoord, "anim-missile", { durationMs: 780 });
      drawTargetEffect(targetCoord, "anim-small-explosion", "", { durationMs: 720, delayMs: 640 });
      return true;
    case "机枪":
      playCardVoice(voice, "machinegun", { layerFallback: true });
      [-0.5, 0.15, 0.55, -0.2, 0.35].forEach((offset, index) => {
        drawTimedBeam(actorCoord, targetCoord, "anim-bullet-trace", {
          durationMs: 170,
          delayMs: index * 95,
          fromDy: offset,
          toDy: offset * 0.45,
        });
      });
      return true;
    case "光枪":
      playCardVoice(voice, "light-rifle");
      [-0.42, 0, 0.42].forEach((offset, index) => {
        drawTimedBeam(actorCoord, targetCoord, "anim-light-rifle", {
          durationMs: 260,
          delayMs: index * 140,
          fromDy: offset,
          toDy: offset * 0.25,
        });
      });
      return true;
    case "霰弹":
      playCardVoice(voice, "shotgun");
      [-1.1, -0.55, 0, 0.55, 1.1].forEach((offset) => {
        drawTimedBeam(actorCoord, targetCoord, "anim-shotgun-pellet", {
          durationMs: 360,
          toDx: offset * 0.38,
          toDy: offset,
        });
      });
      return true;
    case "火焰":
      playCardVoice(voice, "flame");
      drawTargetEffect(targetCoord, "anim-flame", "", { durationMs: 1050 });
      return true;
    case "光束":
      playCardVoice(voice, "beam");
      drawTimedBeam(actorCoord, targetCoord, "anim-heavy-beam", { durationMs: 620 });
      return true;
    case "特殊":
      playCardVoice(voice, "explosion");
      drawTargetEffect(targetCoord, "anim-small-explosion special", "", { durationMs: 960 });
      return true;
    default:
      return false;
  }
}

function playDefenseAnimation(kind, coord, unitIcon = "", voice = "") {
  switch (animationType(kind)) {
    case "抵抗":
      playCardVoice(voice, "guard");
      drawTargetEffect(coord, "anim-defense-cross", "", { durationMs: 900 });
      return true;
    case "闪躲":
      playCardVoice(voice, "dodge");
      if (unitIcon) {
        const pos = percentForCoord(coord);
        if (pos) {
          addAnimationImage("anim-dodge-unit", unitIcon, `left:${pos.left}%; top:${pos.top}%;`);
        }
      } else {
        drawTargetEffect(coord, "anim-dodge-mech", "", { durationMs: 900 });
      }
      return true;
    case "顶盾":
      playCardVoice(voice, "shield");
      drawTargetEffect(coord, "anim-shield-icon", "", { durationMs: 950 });
      return true;
    default:
      return false;
  }
}

function playTeleportAnimation(fromCoord, toCoord, unitIcon, voice = "") {
  playCardVoice(voice, "teleport");
  drawTargetEffect(fromCoord, "anim-teleport-ring out", "", { durationMs: 560 });
  drawTargetEffect(toCoord, "anim-teleport-ring in", "", { durationMs: 720, delayMs: 260 });
  const to = percentForCoord(toCoord);
  if (to && unitIcon) {
    addAnimationImage(
      "anim-teleport-unit",
      unitIcon,
      `left:${to.left}%; top:${to.top}%; animation-delay:260ms;`
    );
  }
}

function actionActuallyStarted(event) {
  const result = String(event?.result || "");
  const type = event?.publicAction?.cardType || event?.type || "";
  if (type === "attack") return ["hit", "miss", "empty"].includes(result);
  if (type === "defense") return result === "defense";
  if (type === "utility") return ["move", "utility"].includes(result);
  return !["invalid", "out-of-range", "no-en"].includes(result);
}

function playResolutionEvent(event) {
  const animation = event?.animation || {};
  const action = event?.publicAction || {};
  const actorCoord = animation.actorCoord;
  const targetCoord = animation.targetCoord;
  const visibleEffects = asArray(animation.effects).filter((effect) => effect.visible);
  const started = actionActuallyStarted(event);
  const visualTargetCoord =
    targetCoord ||
    visibleEffects.find((effect) => ["damage", "miss"].includes(effect.kind) && Array.isArray(effect.coord))?.coord ||
    visibleEffects.find((effect) => Array.isArray(effect.coord))?.coord ||
    null;
  const hasVisibleMove = visibleEffects.some((effect) => effect.kind === "move");
  const hasVisibleDefense = visibleEffects.some((effect) => effect.kind === "defense");
  const hasVisibleSpirit = visibleEffects.some((effect) => effect.kind === "spirit");
  const hasVisibleFlame = visibleEffects.some((effect) => effect.kind === "flame");
  const attackAnimated =
    started && action.cardType === "attack" && playAttackAnimation(action.cardAnimation, actorCoord, visualTargetCoord, action.cardVoice);
  if (started && actorCoord) {
    const pos = percentForCoord(actorCoord);
    playSfx("actor-cue");
    addAnimationElement("anim-pulse actor", `left:${pos.left}%; top:${pos.top}%;`);
  }
  if (started && !hasVisibleMove && !hasVisibleDefense && !hasVisibleSpirit && !hasVisibleFlame && !attackAnimated) {
    playCardVoice(action.cardVoice, action.cardType === "attack" ? "beam" : action.cardType === "defense" ? "shield" : "move");
    drawResolutionBeam(actorCoord, targetCoord, animation.beamMode, action.cardType || event?.type);
  }
  for (const effect of visibleEffects) {
    if (!started && !["spirit", "destroyed", "treasure"].includes(effect.kind)) continue;
    if (effect.kind === "attack-area") {
      asArray(effect.area).forEach((areaCoord) => {
        drawTargetEffect(areaCoord, "anim-attack-area", "", { durationMs: 500 });
      });
      continue;
    }
    const coord = effect.coord || effect.to || visualTargetCoord || actorCoord;
    const pos = percentForCoord(coord);
    if (!pos) continue;
    if (effect.kind === "damage") {
      playSfx("hit");
      addAnimationElement("anim-hit", `left:${pos.left}%; top:${pos.top}%;`);
      addAnimationElement("anim-damage", `left:${pos.left}%; top:${pos.top}%;`, `-${Math.round(effect.damage || 0)}`);
    } else if (effect.kind === "flame") {
      playSfx("fire");
      drawTargetEffect(coord, "anim-flame", "", { durationMs: 1050 });
      addAnimationElement("anim-damage flame", `left:${pos.left}%; top:${pos.top}%;`, `-${Math.round(effect.damage || 0)}`);
    } else if (effect.kind === "miss") {
      if (!(hasVisibleDefense && (effect.text === "DODGE" || !effect.text))) {
        playSfx(effect.text === "DODGE" || !effect.text ? "dodge" : "miss");
      }
      addAnimationElement("anim-miss", `left:${pos.left}%; top:${pos.top}%;`, effect.text || "DODGE");
    } else if (effect.kind === "defense") {
      if (!playDefenseAnimation(effect.cardAnimation || action.cardAnimation, coord, effect.unitIcon || action.unitIcon, effect.cardVoice || action.cardVoice)) {
        playCardVoice(effect.cardVoice || action.cardVoice, "shield");
        addAnimationElement("anim-shield", `left:${pos.left}%; top:${pos.top}%;`);
      }
      if (effect.text) {
        addAnimationElement("anim-defend-text", `left:${pos.left}%; top:${pos.top}%;`, effect.text);
      }
    } else if (effect.kind === "spirit") {
      playSfx("spirit");
      addAnimationElement("anim-spirit", `left:${pos.left}%; top:${pos.top}%;`, effect.spiritName || "精神");
    } else if (effect.kind === "move") {
      const path = [effect.from, ...actionPathCoords(effect).filter(Boolean)];
      if (!path.length || coordKey(path[path.length - 1]) !== coordKey(effect.to)) path.push(effect.to);
      const segments = path
        .map((fromCoord, index) => ({ fromCoord, toCoord: path[index + 1] }))
        .filter((segment) => Array.isArray(segment.fromCoord) && Array.isArray(segment.toCoord));
      const segmentMs = Math.max(260, Math.floor(RESOLUTION_ANIM_MS / Math.max(1, segments.length)));
      if (animationType(effect.cardAnimation || action.cardAnimation) === "瞬移") {
        playTeleportAnimation(effect.from, effect.to, action.unitIcon, action.cardVoice);
      } else {
        playCardVoice(effect.cardVoice || action.cardVoice, "move");
        segments.forEach((segment, index) => {
          if (!action.cardVoice) playSfx("move", { delayMs: index * segmentMs });
          drawResolutionBeam(segment.fromCoord, segment.toCoord, "direct", "utility", {
            durationMs: segmentMs,
            delayMs: index * segmentMs,
          });
          const from = percentForCoord(segment.fromCoord);
          const to = percentForCoord(segment.toCoord);
          if (from && to && action.unitIcon) {
            addAnimationImage(
              "anim-moving-unit",
              action.unitIcon,
              `--from-left:${from.left}%; --from-top:${from.top}%; --to-left:${to.left}%; --to-top:${to.top}%; animation:animMoveUnit ${segmentMs}ms ease-in-out ${index * segmentMs}ms forwards;`
            );
          }
        });
        if (!segments.length) {
          if (!action.cardVoice) playSfx("move");
          drawResolutionBeam(effect.from, effect.to, "direct", "utility");
        }
      }
      addAnimationElement("anim-pulse utility", `left:${pos.left}%; top:${pos.top}%;`);
    } else if (effect.kind === "destroyed") {
      playSfx("destroyed");
      drawTargetEffect(coord, "anim-shotdown-explosion", "", { durationMs: 1500 });
      addAnimationElement("anim-shotdown-text", `left:${pos.left}%; top:${pos.top - 3.8}%;`, "Shot Down", 1700);
    } else if (effect.kind === "treasure") {
      playSfx("treasure");
      addAnimationElement("anim-pulse utility", `left:${pos.left}%; top:${pos.top}%;`);
      addAnimationElement("anim-damage supply", `left:${pos.left}%; top:${pos.top}%;`, `EN+${Math.round(effect.en || 0)}`);
    } else {
      playSfx("move");
      addAnimationElement("anim-pulse utility", `left:${pos.left}%; top:${pos.top}%;`);
    }
  }
  const hasVisibleOutcome = visibleEffects.some((effect) => ["damage", "flame", "miss", "defense", "move", "spirit", "destroyed", "treasure"].includes(effect.kind));
  if (started && (!visibleEffects.length || (event?.result === "empty" && !hasVisibleOutcome)) && visualTargetCoord) {
    const pos = percentForCoord(visualTargetCoord);
    const fallbackText = event?.result === "empty" ? "EMPTY" : event?.result === "miss" ? "DODGE" : "";
    if (event?.result === "empty") playSfx("miss");
    if (event?.result === "miss") playSfx("dodge");
    addAnimationElement(event?.result === "miss" || event?.result === "empty" ? "anim-miss" : "anim-hit", `left:${pos.left}%; top:${pos.top}%;`, fallbackText);
  }
}

function formatCoord(coord) {
  return Array.isArray(coord) ? `(${coord[0]}, ${coord[1]})` : "-";
}

function renderAttackMeta(card) {
  const min = card.min_range || "-";
  const max = card.max_range || "-";
  const aoe = Math.max(0, Number(card.AOE_radius || 0));
  const ratio = card["damage ratio"] || "1.0";
  const effect = card.effect ? ` | 效果 ${card.effect}` : "";
  return `射程 ${min}-${max} | 伤害 ${card.damage || "-"} | AOE ${aoe} | 倍率 ${ratio} | EN ${card.EN_cost || 0}${effect}`;
}

function renderDefenseMeta(card) {
  return `效果 ${card.description || card.effect || "-"} · EN ${card.EN_cost || 0}`;
}

function renderUtilityMeta(card) {
  return `${card.description || card.effect || "-"} · EN ${card.EN_cost || 0}`;
}

function renderSelectCard(title, type, items, selectedId, mapItem) {
  const selectedSet = new Set(asArray(selectedId).map(String));
  const options = items
    .map((item) => {
      const view = mapItem(item);
      return `
        <button class="pick-option ${selectedSet.size ? selectedSet.has(String(view.id)) ? "active" : "" : String(view.id) === String(selectedId) ? "active" : ""}" data-action="pick-${type}" data-id="${escapeHtml(view.id)}" ${view.disabled ? "disabled" : ""}>
          <img src="${normalizeAsset(view.image)}" alt="">
          <span>
            <strong>${escapeHtml(view.name || view.id)}</strong>
            <small>${escapeHtml(view.meta)}</small>
          </span>
        </button>`;
    })
    .join("");
  return `
    <section class="pick-panel">
      <h4>${title}</h4>
      <div class="pick-list">${options}</div>
    </section>
  `;
}

function bindRoomActions(me) {
  document.querySelectorAll("[data-action='team']").forEach((button) => {
    button.addEventListener("click", () => setTeam(button.dataset.team));
  });
  document.querySelector("[data-action='ready']")?.addEventListener("click", () => setReady(!me?.ready));
  document.querySelector("[data-action='start']")?.addEventListener("click", startGame);
  document.querySelector("[data-action='leave']")?.addEventListener("click", leaveRoom);
  document.querySelector("[data-action='confirm-stage']")?.addEventListener("click", confirmStage);
  document.querySelectorAll("[data-action='select-map']").forEach((button) => {
    button.addEventListener("click", () => updateRoomSettings({ mapId: button.dataset.mapId }));
  });
  document.querySelector("[data-action='rule-pilot']")?.addEventListener("change", (event) => {
    updateRoomSettings({ rules: { ...(state.room.rules || {}), pilotPickMode: event.currentTarget.value } });
  });
  document.querySelector("[data-action='rule-unit']")?.addEventListener("change", (event) => {
    updateRoomSettings({ rules: { ...(state.room.rules || {}), unitPickMode: event.currentTarget.value } });
  });
  document.querySelector("[data-action='rule-friendly-attack']")?.addEventListener("change", (event) => {
    updateRoomSettings({ rules: { ...(state.room.rules || {}), friendlyAttackEffect: event.currentTarget.value } });
  });
  document.querySelectorAll("[data-action='pick-pilot']").forEach((button) => {
    button.addEventListener("click", () => {
      const me = asArray(state.room?.players).find((player) => player.username === state.user?.username);
      const ids = new Set(selectedPilotIdsFor(me));
      if (ids.has(button.dataset.id)) ids.delete(button.dataset.id);
      else if (ids.size < MAX_CONTROLLED_UNITS) ids.add(button.dataset.id);
      else {
        setStatus("roomStatus", `每位玩家最多选择 ${MAX_CONTROLLED_UNITS} 名驾驶员`, "error");
        return;
      }
      state.selectedPilotId = Array.from(ids)[0] || "";
      localStorage.setItem("rb_selected_pilot", state.selectedPilotId);
      if (state.room?.status === "started" && state.room?.phase === "pilot") {
        selectPilot(Array.from(ids));
      } else {
        renderRoomPreservingScroll();
      }
    });
  });
  document.querySelectorAll("[data-action='pick-unit']").forEach((button) => {
    button.addEventListener("click", () => {
      const me = asArray(state.room?.players).find((player) => player.username === state.user?.username);
      const pilotCount = Math.min(MAX_CONTROLLED_UNITS, Math.max(1, selectedPilotIdsFor(me).length));
      const ids = selectedUnitIdsFor(me);
      const existingIndex = ids.indexOf(button.dataset.id);
      if (existingIndex >= 0) ids.splice(existingIndex, 1);
      else if (ids.length < pilotCount) ids.push(button.dataset.id);
      else {
        setStatus("roomStatus", `最多选择 ${pilotCount} 台机甲。`, "error");
        return;
      }
      state.selectedUnitId = ids[0] || "";
      state.deckRemovalDraft = { roomId: "", unitId: "", keys: [] };
      localStorage.setItem("rb_selected_unit", state.selectedUnitId);
      if (state.room?.status === "started" && state.room?.phase === "unit") {
        selectUnit(ids);
      } else {
        renderRoomPreservingScroll();
      }
    });
  });
  document.querySelectorAll("[data-action='toggle-card-removal']").forEach((button) => {
      button.addEventListener("click", () => toggleCardRemoval(button.dataset.key, Number(button.dataset.unitIndex || 0)));
  });
  document.querySelectorAll(".battle-hand-grid").forEach((list, index) => {
    list.addEventListener("scroll", () => {
      state.battleHandScroll[index] = { left: list.scrollLeft, top: list.scrollTop };
    });
  });
  document.querySelectorAll(".deck-preview").forEach((list, index) => {
    list.addEventListener("scroll", () => {
      state.deckPreviewScroll[index] = { left: list.scrollLeft, top: list.scrollTop };
    });
  });
  document.querySelector(".battle-slots")?.addEventListener("scroll", (event) => {
    const list = event.currentTarget;
    state.battleSlotScroll = { left: list.scrollLeft, top: list.scrollTop };
  });
  document.querySelectorAll("[data-action='select-battle-hand-unit']").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedBattleHandActor = button.dataset.actorUsername || "";
      renderRoomPreservingScroll();
    });
  });
  document.querySelectorAll("[data-action='select-battle-turn']").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeBattleTurn = Number(button.dataset.turn || 0);
      renderRoomPreservingScroll();
    });
  });
  document.querySelectorAll("[data-action='select-action-actor']").forEach((select) => {
    select.addEventListener("change", () => selectActionActor(Number(select.dataset.turn || 0), select.value));
  });
  document.querySelectorAll("[data-action='select-pre-spirit']").forEach((select) => {
    select.addEventListener("change", () => selectBattleSpirit(Number(select.dataset.turn || 0), select.value, "pre"));
  });
  document.querySelectorAll("[data-action='select-post-spirit']").forEach((select) => {
    select.addEventListener("change", () => selectBattleSpirit(Number(select.dataset.turn || 0), select.value, "post"));
  });
  document.querySelectorAll("[data-action='select-spirit-target']").forEach((select) => {
    select.addEventListener("change", () => selectBattleSpiritTarget(Number(select.dataset.turn || 0), select.value, select.dataset.timing || "pre"));
  });
  document.querySelectorAll(".battle-hand-card[draggable='true'], .battle-slot-card[draggable='true']").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.cardKey || "");
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  document.querySelectorAll("[data-action='drop-battle-card']").forEach((slot) => {
    slot.addEventListener("dragover", (event) => {
      event.preventDefault();
      slot.classList.add("drag-over");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
    slot.addEventListener("drop", (event) => {
      event.preventDefault();
      slot.classList.remove("drag-over");
      assignBattleCardToTurn(event.dataTransfer.getData("text/plain"), Number(slot.dataset.turn || 0));
    });
  });
  document.querySelectorAll("[data-action='drop-card-back']").forEach((zone) => {
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      zone.classList.remove("drag-over");
      unassignBattleCard(event.dataTransfer.getData("text/plain"));
    });
  });
  document.querySelectorAll("[data-action='toggle-reserve-card']").forEach((button) => {
    button.addEventListener("click", () => toggleReserveCard(button.dataset.key));
  });
  document.querySelectorAll("[data-action='pick-target']").forEach((button) => {
    button.addEventListener("click", () =>
      pickBattleTarget(Number(button.dataset.q), Number(button.dataset.r), {
        username: button.dataset.username || "",
        baseTeam: button.dataset.baseTeam || "",
      })
    );
  });
  document.querySelector("[data-action='pick-map-point']")?.addEventListener("click", pickMapPoint);
  document.querySelector("[data-action='pick-map-point']")?.addEventListener("mousemove", updateBattleMapHover);
  document.querySelector("[data-action='pick-map-point']")?.addEventListener("mouseleave", hideBattleMapHover);
  const mapViewport = document.querySelector("[data-action='map-wheel']");
  mapViewport?.addEventListener("wheel", zoomBattleMapAtPointer, { passive: false });
  mapViewport?.addEventListener("mousedown", startBattleMapPan);
  mapViewport?.addEventListener("mousemove", moveBattleMapPan);
  mapViewport?.addEventListener("mouseup", stopBattleMapPan);
  mapViewport?.addEventListener("mouseleave", stopBattleMapPan);
  mapViewport?.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault();
  });
  document.querySelector("[data-action='submit-actions']")?.addEventListener("click", submitBattleActions);
  document.querySelector("[data-action='reset-battle-draft']")?.addEventListener("click", resetBattleDraft);
  document.querySelector("[data-action='skip-resolution']")?.addEventListener("click", skipResolutionPlayback);
  document.querySelector("[data-action='next-round']")?.addEventListener("click", nextBattleRound);
  document.querySelector("[data-action='confirm-loadout']")?.addEventListener("click", confirmLoadout);
  document.querySelector("[data-action='ready-battle']")?.addEventListener("click", readyBattle);
}

async function updateRoomSettings(patch) {
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/settings`, {
      method: "POST",
      body: { sessionId: state.sessionId, ...patch },
    });
    state.room = result.room;
    state.selectedMapId = result.room.mapId;
    localStorage.setItem("rb_selected_map", state.selectedMapId);
    renderRoom();
    setStatus("roomStatus", "房间设置已更新，所有玩家需要重新准备。", "ok");
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function selectPilot(pilotId) {
  try {
    const pilotIds = Array.isArray(pilotId) ? pilotId : [pilotId].filter(Boolean);
    const result = await api(`/api/rooms/${state.currentRoomId}/select-pilot`, {
      method: "POST",
      body: { sessionId: state.sessionId, pilotIds, pilotId: pilotIds[0] || "" },
    });
    state.room = result.room;
    renderRoomPreservingScroll();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function selectUnit(unitId) {
  try {
    const unitIds = Array.isArray(unitId) ? unitId : [unitId].filter(Boolean);
    const result = await api(`/api/rooms/${state.currentRoomId}/select-unit`, {
      method: "POST",
      body: { sessionId: state.sessionId, unitIds, unitId: unitIds[0] || "" },
    });
    state.room = result.room;
    renderRoomPreservingScroll();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

function toggleCardRemoval(key, unitIndex = 0) {
  const me = asArray(state.room?.players).find((player) => player.username === state.user?.username);
  const unit = findUnit(selectedUnitIdsFor(me)[unitIndex] || state.selectedUnitId);
  const draft = getDeckRemovalDraft(me, unit, unitIndex);
  draft.keysByUnit ||= [];
  draft.keysByUnit[unitIndex] ||= [];
  const keys = new Set(draft.keysByUnit[unitIndex]);
  if (keys.has(key)) {
    keys.delete(key);
  } else {
    keys.add(key);
  }
  draft.keysByUnit[unitIndex] = Array.from(keys);
  draft.keys = draft.keysByUnit[0] || [];
  renderRoomPreservingScroll();
}

async function confirmLoadout() {
  try {
    state.deckRemovalDraft.keys = asArray(state.deckRemovalDraft.keys);
    state.deckRemovalDraft.keysByUnit = asArray(state.deckRemovalDraft.keysByUnit);
    const result = await api(`/api/rooms/${state.currentRoomId}/confirm-loadout`, {
      method: "POST",
      body: { sessionId: state.sessionId, removalKeys: state.deckRemovalDraft.keys, removalsByUnit: state.deckRemovalDraft.keysByUnit },
    });
    state.room = result.room;
    renderRoom();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function readyBattle() {
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/ready-battle`, {
      method: "POST",
      body: { sessionId: state.sessionId },
    });
    state.room = result.room;
    renderRoom();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

function assignBattleCard(key) {
  assignBattleCardToTurn(key, state.activeBattleTurn);
}

function isBattleCardAssigned(key) {
  if (!key) return false;
  const draft = getBattleDraft();
  const parsed = parseBattleCardToken(key);
  return asArray(draft.actions).some(
    (action) => action?.cardKey === parsed.cardKey && (!parsed.actorUsername || action?.actorUsername === parsed.actorUsername)
  );
}

function unassignBattleCard(key) {
  if (!key) return;
  const parsed = parseBattleCardToken(key);
  const draft = getBattleDraft();
  draft.actions = asArray(draft.actions);
  let removed = false;
  draft.actions.forEach((action) => {
    if (action.cardKey === parsed.cardKey && (!parsed.actorUsername || action.actorUsername === parsed.actorUsername)) {
      action.cardKey = "";
      action.target = null;
      action.targetPath = [];
      action.targetUsername = "";
      action.targetBaseTeam = "";
      removed = true;
    }
  });
  if (removed) renderRoomPreservingScroll();
}

function assignBattleCardToTurn(key, turn) {
  const parsed = parseBattleCardToken(key);
  const entry = findHandEntryByKey(key);
  if (!parsed.cardKey || !entry) return;
  const draft = getBattleDraft();
  draft.actions = asArray(draft.actions);
  draft.reserveKeys = asArray(draft.reserveKeys);
  const previousActions = draft.actions.map((action) => ({
    ...action,
    target: actionTargetCoord(action) || null,
    targetPath: actionPathCoords(action),
  }));
  const previousReserveKeys = [...draft.reserveKeys];
  const targetTurn = Math.max(0, Math.min(draft.actions.length - 1, Number(turn || 0)));
  const actor = findBattleUnitForCardKey(key);
  const actorUsername = actor?.username || parsed.actorUsername || entry.actorUsername || "";
  const fixedActor = findOwnedBattleUnits()[targetTurn];
  if (fixedActor && actorUsername && fixedActor.username !== actorUsername) {
    renderRoomPreservingScroll();
    setStatus("roomStatus", `这张牌属于 ${actor?.nickname || "其他机甲"}，请放到对应机甲的卡槽。`, "error");
    return;
  }
  const sourceTurn = draft.actions.findIndex((action) => action?.cardKey === parsed.cardKey && action?.actorUsername === actorUsername);
  const targetCardKey = draft.actions[targetTurn]?.cardKey || "";
  const targetActorUsername = draft.actions[targetTurn]?.actorUsername || "";
  const targetHasSameActorCard = Boolean(
    targetCardKey && targetActorUsername === actorUsername && targetCardKey !== parsed.cardKey
  );
  const targetHasDifferentCard = Boolean(
    targetCardKey && (targetCardKey !== parsed.cardKey || targetActorUsername !== actorUsername)
  );
  const duplicateActorTurn = draft.actions.findIndex(
    (action, index) => index !== sourceTurn && index !== targetTurn && action?.actorUsername === actorUsername && action?.cardKey
  );
  if (duplicateActorTurn >= 0) {
    renderRoomPreservingScroll();
    setStatus("roomStatus", "每台机甲每回合最多只能使用 1 张卡牌。", "error");
    return;
  }
  if (sourceTurn === targetTurn) {
    state.activeBattleTurn = targetTurn;
    return;
  }
  draft.reserveKeys = draft.reserveKeys.filter((item) => item !== parsed.cardKey);
  if (sourceTurn >= 0) {
    draft.actions[sourceTurn] = {
      ...(draft.actions[sourceTurn] || { turn: sourceTurn }),
      turn: sourceTurn,
      actorUsername: targetHasDifferentCard && !targetHasSameActorCard ? targetActorUsername : draft.actions[sourceTurn]?.actorUsername || actorUsername,
      cardKey: targetHasDifferentCard && !targetHasSameActorCard ? targetCardKey : "",
      target: null,
      targetPath: [],
      targetUsername: "",
      targetBaseTeam: "",
    };
  } else {
    draft.actions.forEach((action) => {
      if (action.cardKey === parsed.cardKey && action.actorUsername === actorUsername) {
        action.cardKey = "";
        action.target = null;
        action.targetPath = [];
        action.targetUsername = "";
        action.targetBaseTeam = "";
      }
    });
  }
  state.activeBattleTurn = targetTurn;
  draft.actions[targetTurn] = {
    ...(draft.actions[targetTurn] || { turn: targetTurn }),
    turn: targetTurn,
    actorUsername,
    cardKey: parsed.cardKey,
    target: null,
    targetPath: [],
    targetUsername: "",
    targetBaseTeam: "",
  };
  const duplicate = duplicateCooldownCardInActions(draft.actions);
  if (duplicate) {
    draft.actions = previousActions;
    draft.reserveKeys = previousReserveKeys;
    renderRoomPreservingScroll();
    setStatus("roomStatus", `同一回合内，${battleCardLabel(duplicate)} 这类有冷却的卡牌最多只能设定一次。`, "error");
    return;
  }
  renderRoomPreservingScroll();
}

function toggleReserveCard(key) {
  const parsed = parseBattleCardToken(key);
  const reserveKey = parsed.cardKey;
  const draft = getBattleDraft();
  draft.actions = asArray(draft.actions);
  draft.reserveKeys = asArray(draft.reserveKeys);
  const keys = new Set(draft.reserveKeys);
  if (keys.has(reserveKey)) {
    keys.delete(reserveKey);
  } else if (keys.size >= 2) {
    setStatus("roomStatus", "每回合最多保留 2 张卡牌。", "error");
    return;
  } else {
    draft.actions.forEach((action) => {
      if (action.cardKey === reserveKey && (!parsed.actorUsername || action.actorUsername === parsed.actorUsername)) action.cardKey = "";
    });
    keys.add(reserveKey);
  }
  draft.reserveKeys = Array.from(keys);
  renderRoomPreservingScroll();
}

function pickBattleTarget(q, r, targetInfo = {}) {
  const coord = [q, r];
  state.selectedBattleCoord = coord;
  const draft = getBattleDraft();
  draft.actions = asArray(draft.actions);
  const action = draft.actions[state.activeBattleTurn] || { turn: state.activeBattleTurn, cardKey: "" };
  const entry = findHandEntryByKey(battleCardToken(action.actorUsername, action.cardKey));
  const isAttack = entry?.type === "attack";
  draft.actions[state.activeBattleTurn] = {
    ...action,
    target: coord,
    targetPath: [],
    targetUsername: isAttack ? "" : targetInfo.username || "",
    targetBaseTeam: isAttack ? "" : targetInfo.baseTeam || "",
  };
  renderRoomPreservingScroll();
}

function getBattleCoordFromPointer(event, stack = event.currentTarget) {
  if (!stack) return null;
  const rect = stack.getBoundingClientRect();
  const left = ((event.clientX - rect.left) / rect.width) * 100;
  const top = ((event.clientY - rect.top) / rect.height) * 100;
  let best = null;
  let bestDistance = Infinity;
  for (const tile of asArray(state.room?.mapTiles)) {
    const pos = battleCoordToPercent(tile.coord);
    const distance = Math.hypot(pos.left - left, pos.top - top);
    if (distance < bestDistance) {
      best = tile.coord;
      bestDistance = distance;
    }
  }
  return best;
}

function updateBattleMapHover(event) {
  if (state.battleMapDrag) {
    hideBattleMapHover();
    return;
  }
  const coord = getBattleCoordFromPointer(event);
  const marker = document.querySelector(".map-hover-target");
  if (!coord || !marker) return;
  refreshBattleSidebarForCoord(coord);
  const pos = battleCoordToPercent(coord);
  const hex = battleHexSizePercent();
  marker.style.left = `${pos.left}%`;
  marker.style.top = `${pos.top}%`;
  marker.style.setProperty("--hex-width", `${hex.width}%`);
  marker.style.setProperty("--hex-height", `${hex.height}%`);
  marker.style.display = "block";
}

function hideBattleMapHover() {
  const marker = document.querySelector(".map-hover-target");
  if (marker) marker.style.display = "none";
}

function refreshBattleSidebarForCoord(coord, force = false) {
  if (!Array.isArray(coord) || (!force && coordKey(state.selectedBattleCoord) === coordKey(coord))) return;
  state.selectedBattleCoord = coord;
  const sidebar = document.querySelector(".battle-sidebar");
  if (sidebar) sidebar.outerHTML = renderBattleStatusSidebar();
  if (state.detailKey) {
    const player = playerAtSelectedBattleCoord();
    const unit = findUnit(player?.selectedUnitId);
    const pilot = findPilot(player?.selectedPilotId);
    showFloatingTooltip(state.detailKey === "pilot" ? renderPilotTextDetails(pilot) : renderUnitTextDetails(unit), "text-tooltip");
  }
}

function pickMapPoint(event) {
  if (state.battleMapPanMoved) {
    state.battleMapPanMoved = false;
    return;
  }
  if (event.target.closest(".map-token")) return;
  const best = getBattleCoordFromPointer(event);
  if (best) pickBattleTarget(best[0], best[1]);
}

function zoomBattleMapAtPointer(event) {
  event.preventDefault();
  const viewport = event.currentTarget;
  const stack = viewport.querySelector(".battle-map-stack");
  if (!stack) return;
  const viewportRect = viewport.getBoundingClientRect();
  const stackRect = stack.getBoundingClientRect();
  const offsetX = event.clientX - viewportRect.left;
  const offsetY = event.clientY - viewportRect.top;
  const oldWidth = Math.max(1, stack.offsetWidth);
  const oldHeight = Math.max(1, stack.offsetHeight);
  const ratioX = Math.max(0, Math.min(1, (event.clientX - stackRect.left) / oldWidth));
  const ratioY = Math.max(0, Math.min(1, (event.clientY - stackRect.top) / oldHeight));
  const delta = event.deltaY < 0 ? 0.1 : -0.1;
  state.battleMapZoom = Math.max(0.49, Math.min(2.2, Number((state.battleMapZoom + delta).toFixed(2))));
  stack.style.setProperty("--map-scale", state.battleMapZoom);
  requestAnimationFrame(() => {
    viewport.scrollLeft = stack.offsetLeft + ratioX * stack.offsetWidth - offsetX;
    viewport.scrollTop = stack.offsetTop + ratioY * stack.offsetHeight - offsetY;
  });
}

function startBattleMapPan(event) {
  if (event.button !== 1) return;
  event.preventDefault();
  state.battleMapDrag = {
    x: event.clientX,
    y: event.clientY,
    left: event.currentTarget.scrollLeft,
    top: event.currentTarget.scrollTop,
    moved: false,
  };
  state.battleMapPanMoved = false;
  event.currentTarget.classList.add("dragging");
}

function moveBattleMapPan(event) {
  const drag = state.battleMapDrag;
  if (!drag) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  event.currentTarget.scrollLeft = drag.left - dx;
  event.currentTarget.scrollTop = drag.top - dy;
}

function stopBattleMapPan(event) {
  const drag = state.battleMapDrag;
  if (!drag) return;
  event.currentTarget?.classList?.remove("dragging");
  state.battleMapPanMoved = Boolean(drag.moved);
  state.battleMapDrag = null;
  if (state.battleMapPanMoved) {
    setTimeout(() => {
      state.battleMapPanMoved = false;
    }, 250);
  }
}

function selectActionActor(turn, actorUsername) {
  const draft = getBattleDraft();
  draft.actions = asArray(draft.actions);
  const action = draft.actions[turn] || { turn, cardKey: "", target: null };
  draft.actions[turn] = { ...action, turn, actorUsername, cardKey: "", target: null, targetPath: [], targetUsername: "", targetBaseTeam: "" };
  renderRoomPreservingScroll();
}

function selectBattleSpirit(turn, spiritId, timing = "pre") {
  const draft = getBattleDraft();
  draft.actions = asArray(draft.actions);
  const action = draft.actions[turn] || { turn, cardKey: "", target: null };
  const actor = findOwnedBattleUnits().find((unit) => unit.username === action.actorUsername) || findBattleSelf();
  const currentSP = Number(actor?.combat?.sp || 0);
  const spiritField = timing === "post" ? "postSpiritId" : "preSpiritId";
  const targetField = timing === "post" ? "postSpiritTargetUsername" : "preSpiritTargetUsername";
  const nextAction = {
    ...action,
    turn,
    actorUsername: actor?.username || action.actorUsername || "",
    [spiritField]: spiritId,
    [targetField]: spiritTargetMode(spiritId) ? defaultSpiritTargetUsername(spiritId, action?.[targetField] || "", actor) : "",
  };
  const totalCost = battleActionSpiritCost(nextAction);
  if (totalCost > currentSP) {
    renderRoomPreservingScroll();
    setStatus("roomStatus", `精神 SP 不足：当前 ${currentSP}，前置/后置合计需要 ${totalCost}`, "error");
    return;
  }
  draft.actions = draft.actions.map((item, index) => (index === turn ? nextAction : item));
  renderRoomPreservingScroll();
}

function selectBattleSpiritTarget(turn, spiritTargetUsername, timing = "pre") {
  const draft = getBattleDraft();
  draft.actions = asArray(draft.actions);
  const action = draft.actions[turn] || { turn, cardKey: "", target: null };
  const field = timing === "post" ? "postSpiritTargetUsername" : "preSpiritTargetUsername";
  draft.actions[turn] = { ...action, turn, [field]: spiritTargetUsername };
  renderRoomPreservingScroll();
}

function emptyBattleAction(turn) {
  return {
    turn,
    actorUsername: findOwnedBattleUnits()[turn % Math.max(1, findOwnedBattleUnits().length)]?.username || "",
    preSpiritId: "",
    preSpiritTargetUsername: "",
    postSpiritId: "",
    postSpiritTargetUsername: "",
    cardKey: "",
    target: null,
    targetPath: [],
    targetUsername: "",
    targetBaseTeam: "",
  };
}

async function resetBattleDraft() {
  const draft = getBattleDraft();
  draft.actions = Array.from({ length: Math.max(1, findOwnedBattleUnits().length) }, (_, turn) => emptyBattleAction(turn));
  draft.reserveKeys = [];
  state.activeBattleTurn = 0;
  state.selectedBattleCoord = null;
  hideBattleMapHover();
  const self = findBattleSelf();
  if (!self?.actionConfirmed) {
    renderRoomPreservingScroll();
    return;
  }
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/reset-actions`, {
      method: "POST",
      body: { sessionId: state.sessionId },
    });
    state.room = result.room;
    state.battleDraft = { roomId: "", round: 0, actions: [], reserveKeys: [] };
    renderRoom();
    setStatus("roomStatus", "已撤回本回合行动，可以重新设定。", "ok");
  } catch (error) {
    renderRoomPreservingScroll();
    setStatus("roomStatus", error.message, "error");
  }
}

async function submitBattleActions() {
  try {
    const draft = getBattleDraft();
    const duplicate = duplicateCooldownCardInActions(draft.actions);
    if (duplicate) {
      setStatus("roomStatus", `同一回合内，${battleCardLabel(duplicate)} 这类有冷却的卡牌最多只能设定一次。`, "error");
      return;
    }
    draft.actions = asArray(draft.actions).map((action, turn) => {
      const parsed = parseBattleCardToken(action?.cardKey);
      const actorUsername = action?.actorUsername || parsed.actorUsername || "";
      const actor = findOwnedBattleUnits().find((unit) => unit.username === actorUsername) || findOwnedBattleUnits()[turn] || findBattleSelf();
      const cardKey = parsed.cardKey || action?.cardKey || "";
      const entry = findHandEntryByKey(battleCardToken(actorUsername, cardKey));
      const isAttack = entry?.type === "attack";
      return {
        ...action,
        turn,
        actorUsername,
        cardKey,
        target: isAttack ? action?.target || null : action?.target || null,
        targetPath: isAttack ? [] : asArray(action?.targetPath),
        targetUsername: isAttack ? "" : action?.targetUsername || "",
        targetBaseTeam: isAttack ? "" : action?.targetBaseTeam || "",
        preSpiritTargetUsername: spiritTargetMode(action?.preSpiritId)
          ? defaultSpiritTargetUsername(action?.preSpiritId, action?.preSpiritTargetUsername || "", actor)
          : "",
        postSpiritTargetUsername: spiritTargetMode(action?.postSpiritId)
          ? defaultSpiritTargetUsername(action?.postSpiritId, action?.postSpiritTargetUsername || "", actor)
          : "",
      };
    });
    const result = await api(`/api/rooms/${state.currentRoomId}/set-actions`, {
      method: "POST",
      body: { sessionId: state.sessionId, actions: asArray(draft.actions), reserveKeys: asArray(draft.reserveKeys) },
    });
    state.room = result.room;
    state.battleDraft = { roomId: "", round: 0, actions: [], reserveKeys: [] };
    if (state.resolutionPlayback.timer) clearTimeout(state.resolutionPlayback.timer);
    state.resolutionPlayback = { key: "", index: 0, timer: null, skipped: false };
    renderRoom();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function nextBattleRound() {
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/next-round`, {
      method: "POST",
      body: { sessionId: state.sessionId },
    });
    state.room = result.room;
    state.battleDraft = { roomId: "", round: 0, actions: [], reserveKeys: [] };
    if (state.resolutionPlayback.timer) clearTimeout(state.resolutionPlayback.timer);
    if (result.room?.battle?.stage === "resolved") {
      const events = asArray(result.room?.battle?.resolutionEvents);
      state.resolutionPlayback = { key: resolutionPlaybackKey(), index: events.length, timer: null, skipped: true };
    } else {
      state.resolutionPlayback = { key: "", index: 0, timer: null, skipped: false };
    }
    renderRoom();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function confirmStage() {
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/confirm-stage`, {
      method: "POST",
      body: { sessionId: state.sessionId },
    });
    state.room = result.room;
    renderRoom();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function setTeam(team) {
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/team`, {
      method: "POST",
      body: { sessionId: state.sessionId, team },
    });
    state.room = result.room;
    renderRoom();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function setReady(ready) {
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/ready`, {
      method: "POST",
      body: { sessionId: state.sessionId, ready },
    });
    state.room = result.room;
    renderRoom();
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function startGame() {
  try {
    const result = await api(`/api/rooms/${state.currentRoomId}/start`, {
      method: "POST",
      body: { sessionId: state.sessionId },
    });
    state.room = result.room;
    renderRoom();
    setStatus("roomStatus", "游戏已开始，请确认出击编队。", "ok");
  } catch (error) {
    setStatus("roomStatus", error.message, "error");
  }
}

async function leaveRoom() {
  try {
    await api(`/api/rooms/${state.currentRoomId}/leave`, {
      method: "POST",
      body: { sessionId: state.sessionId },
    });
  } catch {
    // Leaving should take the player back even if the room was already gone.
  }
  stopPolling();
  state.currentRoomId = "";
  state.room = null;
  state.view = "lobby";
  await refreshRooms();
  render();
}

function bindGlobalActions() {
  bindDetailKeyActions();
  bindFloatingTooltips();
  document.querySelectorAll("[data-action='open-newbie-guide']").forEach((button) => {
    button.addEventListener("click", () => {
      state.showNewbieGuide = true;
      render();
    });
  });
  document.querySelectorAll("[data-action='close-newbie-guide']").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target !== element && !event.target.closest?.(".guide-close")) return;
      state.showNewbieGuide = false;
      render();
    });
  });
  document.querySelectorAll("[data-action='logout']").forEach((button) => {
    button.addEventListener("click", async () => {
      await api("/api/logout", { method: "POST", body: { sessionId: state.sessionId } }).catch(() => {});
      localStorage.removeItem("rb_session");
      state.sessionId = "";
      state.user = null;
      state.room = null;
      state.currentRoomId = "";
      state.view = "auth";
      render();
    });
  });
}

function ensureFloatingTooltip() {
  let tooltip = document.querySelector(".floating-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "floating-tooltip";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function positionFloatingTooltip(tooltip) {
  const pad = 14;
  const x = Number(state.pointer?.x || 0) + 18;
  const y = Number(state.pointer?.y || 0) + 18;
  tooltip.style.left = `${Math.min(window.innerWidth - tooltip.offsetWidth - pad, Math.max(pad, x))}px`;
  tooltip.style.top = `${Math.min(window.innerHeight - tooltip.offsetHeight - pad, Math.max(pad, y))}px`;
}

function showFloatingTooltip(html, variant = "") {
  const tooltip = ensureFloatingTooltip();
  tooltip.className = `floating-tooltip ${variant}`.trim();
  tooltip.innerHTML = html || "";
  tooltip.hidden = false;
  positionFloatingTooltip(tooltip);
}

function hideFloatingTooltip() {
  const tooltip = document.querySelector(".floating-tooltip");
  if (tooltip) tooltip.hidden = true;
}

function ensureOrderDeckPopup() {
  let popup = document.querySelector(".order-deck-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.className = "order-deck-popup";
    document.body.appendChild(popup);
  }
  return popup;
}

function positionOrderDeckPopup(popup, x, y) {
  const pad = 14;
  popup.style.left = `${Math.min(window.innerWidth - popup.offsetWidth - pad, Math.max(pad, x + 10))}px`;
  popup.style.top = `${Math.min(window.innerHeight - popup.offsetHeight - pad, Math.max(pad, y + 10))}px`;
}

function showOrderDeckPopup(player, x, y) {
  const popup = ensureOrderDeckPopup();
  popup.innerHTML = `
    <div class="order-deck-popup-head">
      <strong>战斗卡组</strong>
      <button type="button" data-action="close-order-deck">×</button>
    </div>
    ${renderOrderDeckTooltip(player)}
  `;
  popup.hidden = false;
  positionOrderDeckPopup(popup, x, y);
}

function hideOrderDeckPopup() {
  const popup = document.querySelector(".order-deck-popup");
  if (popup) popup.hidden = true;
}

function playerAtSelectedBattleCoord() {
  const self = findBattleSelf();
  const selected = state.selectedBattleCoord || self?.combat?.coord || null;
  const selectedVisible = isCoordVisible(selected);
  return asArray(state.room?.battle?.players).find(
    (player) =>
      coordKey(player.combat?.coord) === coordKey(selected) &&
      (player.team === self?.team || selectedVisible)
  );
}

function bindFloatingTooltips() {
  if (state.tooltipBound) return;
  state.tooltipBound = true;
  document.addEventListener("mousemove", (event) => {
    state.pointer = { x: event.clientX, y: event.clientY };
    const tooltip = document.querySelector(".floating-tooltip:not([hidden])");
    if (tooltip && !state.detailKey) positionFloatingTooltip(tooltip);
  });
  document.addEventListener("click", (event) => {
    state.pointer = { x: event.clientX, y: event.clientY };
    const close = event.target.closest?.("[data-action='close-order-deck']");
    if (close) {
      hideOrderDeckPopup();
      hideFloatingTooltip();
      return;
    }
    const databaseUnit = event.target.closest?.("[data-tooltip='database-unit']");
    if (databaseUnit) {
      const unit = getPlayableUnits().find((item) => String(item.unit_ID) === String(databaseUnit.dataset.unitId));
      showFloatingTooltip(renderDatabaseUnitArt(unit), "database-unit-tooltip");
      return;
    }
    const databasePilot = event.target.closest?.("[data-tooltip='database-pilot']");
    if (databasePilot) {
      const pilot = getPilots().find((item) => String(item.pilot_ID) === String(databasePilot.dataset.pilotId));
      showFloatingTooltip(renderDatabasePilotDescription(pilot), "text-tooltip database-pilot-tooltip");
      return;
    }
    const orderCard = event.target.closest?.("[data-tooltip='order-deck']");
    if (orderCard) {
      const player = asArray(state.room?.battle?.players).find((item) => item.username === orderCard.dataset.username);
      showOrderDeckPopup(player, event.clientX, event.clientY);
      return;
    }
    const popup = event.target.closest?.(".order-deck-popup");
    if (!popup) {
      hideOrderDeckPopup();
      if (!state.detailKey) hideFloatingTooltip();
    }
  });
  document.addEventListener("mouseover", (event) => {
    const card = event.target.closest?.(".order-deck-popup-card");
    if (!card) return;
    showFloatingTooltip(`<img class="tooltip-card-large" src="${escapeHtml(card.dataset.largeSrc || card.src)}" alt="">`, "card-image-tooltip");
  });
  document.addEventListener("mouseout", (event) => {
    const card = event.target.closest?.(".order-deck-popup-card");
    if (!card || card.contains(event.relatedTarget)) return;
    if (!state.detailKey) hideFloatingTooltip();
  });
}

function bindDetailKeyActions() {
  if (state.detailKeyBound) return;
  state.detailKeyBound = true;
  const setDetailKey = (next) => {
    if (state.detailKey === next) {
      state.detailKey = "";
      hideFloatingTooltip();
      return;
    }
    state.detailKey = next;
    if (!next) {
      hideFloatingTooltip();
      return;
    }
    if (!document.querySelector(".status-object.status-unit")) {
      hideFloatingTooltip();
      state.detailKey = "";
      return;
    }
    const player = playerAtSelectedBattleCoord();
    const unit = findUnit(player?.selectedUnitId);
    const pilot = findPilot(player?.selectedPilotId);
    showFloatingTooltip(next === "pilot" ? renderPilotTextDetails(pilot) : renderUnitTextDetails(unit), "text-tooltip");
  };
  document.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
    const key = event.key.toLowerCase();
    if (key === "q") {
      setDetailKey("pilot");
    } else if (key === "w") {
      event.preventDefault();
      setDetailKey("unit");
    } else if (event.key === "Escape") {
      state.showNewbieGuide = false;
      setDetailKey("");
      hideOrderDeckPopup();
      render();
    }
  });
  window.addEventListener("blur", () => {
    setDetailKey("");
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

boot().catch((error) => {
  app.innerHTML = `<section class="panel"><h2>启动失败</h2><p>${escapeHtml(error.message)}</p></section>`;
});
