const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STORAGE_DIR = path.join(ROOT, "storage");
const STATE_FILE = process.env.ROBOT_BATTLE_STATE_FILE || path.join(STORAGE_DIR, "game-state.json");
const GAME_DATA_FILE = path.join(PUBLIC_DIR, "data", "game-data.json");

const DEFAULT_MAP_ID = "001";
const DEFAULT_AI_MAP_ID = "002";
const DEFAULT_AI_PILOT_ID = "099";
const DEFAULT_RULES = {
  pilotPickMode: "blind",
  unitPickMode: "free",
  friendlyAttackEffect: "full",
};
const DEFAULT_BATTLE_DECK_LIMIT = 8;
const DEFAULT_UNIT_EN = 160;
const MAX_CONTROLLED_UNITS = 3;
const PILOT_PICK_MODES = new Set(["blind"]);
const UNIT_PICK_MODES = new Set(["free"]);
const FRIENDLY_ATTACK_EFFECTS = new Set(["full", "half", "immune"]);
const BATTLE_PHASES = new Set(["pilot", "unit", "loadout", "reveal", "battle", "ended"]);
const AI_TYPES = new Set(["battle_fanatic"]);
const AXIAL_DIRECTIONS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

const users = new Map();
const sessions = new Map();
const rooms = new Map();
let gameDataCache = null;
let gameDataMtime = 0;
const mapDefinitionCache = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

function makeId(prefix, bytes = 4) {
  return `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
}

function normalizeRules(rules = {}) {
  const pilotPickMode = PILOT_PICK_MODES.has(rules.pilotPickMode) ? rules.pilotPickMode : DEFAULT_RULES.pilotPickMode;
  const unitPickMode = UNIT_PICK_MODES.has(rules.unitPickMode) ? rules.unitPickMode : DEFAULT_RULES.unitPickMode;
  const friendlyAttackEffect = FRIENDLY_ATTACK_EFFECTS.has(rules.friendlyAttackEffect)
    ? rules.friendlyAttackEffect
    : DEFAULT_RULES.friendlyAttackEffect;
  return { pilotPickMode, unitPickMode, friendlyAttackEffect };
}

function isObserverPlayer(player) {
  return Boolean(player?.observer);
}

function isAiPlayer(player) {
  return Boolean(player?.isAI || AI_TYPES.has(player?.aiType));
}

function isCombatant(player) {
  return Boolean(player?.combatant);
}

function battleParticipants(room) {
  if (Array.isArray(room?.combatants) && room.combatants.length) {
    return room.combatants.filter((player) => !isObserverPlayer(player) && player.team);
  }
  return Array.from(room?.players?.values?.() || []).filter((player) => !isObserverPlayer(player) && !isCombatant(player) && player.team);
}

function roomPlayers(room) {
  return Array.from(room?.players?.values?.() || []).filter((player) => !isCombatant(player));
}

function findBattleParticipant(room, username) {
  const key = String(username || "");
  return battleParticipants(room).find((player) => player.username === key) || room?.players?.get?.(key) || null;
}

function playerPilotIds(player) {
  const ids = Array.isArray(player?.selectedPilotIds) ? player.selectedPilotIds : player?.selectedPilotId ? [player.selectedPilotId] : [];
  return ids.map((id) => String(id || "").trim()).filter(Boolean);
}

function normalizeSelectionIds(value, fallback = "") {
  const raw = Array.isArray(value) ? value : fallback ? [fallback] : [];
  return Array.from(new Set(raw.map((id) => String(id || "").trim()).filter(Boolean)));
}

function playerUnitIds(player) {
  const ids = Array.isArray(player?.selectedUnitIds) ? player.selectedUnitIds : player?.selectedUnitId ? [player.selectedUnitId] : [];
  return ids.map((id) => String(id || "").trim()).filter(Boolean);
}

function ownerCombatants(room, ownerUsername) {
  return battleParticipants(room).filter((player) => (player.ownerUsername || player.username) === ownerUsername);
}

function normalizeCardKey(value) {
  return String(value || "").trim();
}

function emptyBattleAction(turn = 0) {
  return {
    turn,
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

function loadGameData() {
  const stat = fs.statSync(GAME_DATA_FILE);
  if (!gameDataCache || stat.mtimeMs !== gameDataMtime) {
    gameDataCache = JSON.parse(fs.readFileSync(GAME_DATA_FILE, "utf8"));
    gameDataMtime = stat.mtimeMs;
  }
  return gameDataCache;
}

function getUnitsData() {
  return loadGameData()?.["unit_data.xlsx"]?.Units || [];
}

function findUnitData(unitId) {
  return getUnitsData().find((unit) => String(unit.unit_ID) === String(unitId)) || null;
}

function isPlayableUnitData(unit) {
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

function idList(value) {
  return String(value || "")
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unitMaxEn(unit) {
  return Number(unit?.max_EN || DEFAULT_UNIT_EN);
}

function unitFeatureIds(playerOrUnitId) {
  const unit =
    typeof playerOrUnitId === "object"
      ? findUnitData(playerOrUnitId?.selectedUnitId)
      : findUnitData(playerOrUnitId);
  return idList(unit?.features).map((id) => id.padStart(3, "0"));
}

function hasUnitFeature(player, featureId) {
  const targetId = String(featureId || "").padStart(3, "0");
  return unitFeatureIds(player).includes(targetId);
}

function findUnitFeatureData(featureId) {
  const targetId = String(featureId || "").padStart(3, "0");
  return (loadGameData()?.["unit_data.xlsx"]?.Feature_list || []).find(
    (feature) => String(feature.feature_ID).padStart(3, "0") === targetId
  ) || null;
}

function findPilotData(pilotId) {
  return (loadGameData()?.["pilot_data.xlsx"]?.Pilot || []).find((pilot) => String(pilot.pilot_ID) === String(pilotId)) || null;
}

function findSpiritData(spiritId) {
  return (loadGameData()?.["pilot_data.xlsx"]?.Spirit_list || []).find((spirit) => String(spirit.spirit_ID) === String(spiritId)) || null;
}

function mapDataFields(mapId) {
  const targetId = String(mapId || DEFAULT_MAP_ID).padStart(3, "0");
  const sheets = loadGameData()?.["map_data.xlsx"] || {};
  for (const rows of Object.values(sheets)) {
    const fields = {};
    for (const row of rows || []) {
      const key = row.fields || row.field || row.key || row.map_ID;
      if (key) fields[String(key)] = row["description/value"] ?? row.value ?? row.description ?? "";
    }
    if (String(fields.map_ID || "").padStart(3, "0") === targetId) return fields;
  }
  return {};
}

function mapTeamMaxPlayers(mapId) {
  const generated = loadMapDefinition(mapId);
  const fields = mapDataFields(mapId);
  const raw = generated?.team_max_players || {};
  const teamI = Number(raw["Team I"] ?? fields.Team_I_max_player ?? 6);
  const teamII = Number(raw["Team II"] ?? fields.Team_II_max_player ?? 6);
  return {
    "Team I": Math.max(1, Number.isFinite(teamI) ? teamI : 6),
    "Team II": Math.max(1, Number.isFinite(teamII) ? teamII : 6),
  };
}

function mapTotalMaxPlayers(mapId) {
  const limits = mapTeamMaxPlayers(mapId);
  return limits["Team I"] + limits["Team II"];
}

function getTalentData() {
  return loadGameData()?.["pilot_data.xlsx"]?.Talent_list || [];
}

function pilotSpiritIds(pilotId) {
  const pilot = findPilotData(pilotId);
  return String(pilot?.spirits || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pilotTalentIds(pilotId) {
  const pilot = findPilotData(pilotId);
  return String(pilot?.talents || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function playerTalentIds(player) {
  return pilotTalentIds(player?.selectedPilotId);
}

function hasTalent(player, talentId) {
  return playerTalentIds(player).includes(String(talentId).padStart(3, "0"));
}

function parseCardRefs(value) {
  return String(value || "")
    .split(/[,，]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [rawId, count = "1"] = part.split(/[＊*]/).map((item) => item.trim());
      const id = String(rawId || "").replace(/[^\d]/g, "").padStart(3, "0");
      return { id, count: Math.max(1, Number(String(count).replace(/[^\d.-]/g, "")) || 1) };
    });
}

function expandUnitDeck(unitId) {
  const unit = findUnitData(unitId);
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
      for (let i = 0; i < count; i += 1) {
        const nextCopy = (copyCounts.get(id) || 0) + 1;
        copyCounts.set(id, nextCopy);
        deck.push({
          key: `${group.type}:${id}:${nextCopy}`,
          type: group.type,
          id,
        });
      }
    }
  }
  return deck;
}

function validateDeckRemovals(unitId, removalKeys) {
  const keys = Array.isArray(removalKeys) ? removalKeys : [];
  const uniqueKeys = Array.from(new Set(keys.map(normalizeCardKey).filter(Boolean)));
  const validKeys = new Set(expandUnitDeck(unitId).map((entry) => entry.key));
  if (!validKeys.size) {
    const error = new Error("未找到该机甲的卡组配置");
    error.status = 400;
    throw error;
  }
  for (const key of uniqueKeys) {
    if (!validKeys.has(key)) {
      const error = new Error("卡组删除项不合法");
      error.status = 400;
      throw error;
    }
  }
  if (validKeys.size - uniqueKeys.length > DEFAULT_BATTLE_DECK_LIMIT) {
    const error = new Error(`战斗卡组最多保留 ${DEFAULT_BATTLE_DECK_LIMIT} 张牌，请继续删除卡牌。`);
    error.status = 400;
    throw error;
  }
  return uniqueKeys;
}

function getCardLists() {
  const unitData = loadGameData()?.["unit_data.xlsx"] || {};
  return {
    attack: unitData.Attack_card_list || [],
    defense: unitData.Defense_card_list || [],
    utility: unitData.Utility_card_list || [],
  };
}

function findCardData(type, id) {
  const lists = getCardLists();
  const idKey = type === "attack" ? "A_card_ID" : type === "defense" ? "D_card_ID" : "U_card_ID";
  return (lists[type] || []).find((card) => String(card[idKey]) === String(id)) || null;
}

function cardCooldownKey(entry) {
  return entry?.key || `${entry?.type || ""}:${entry?.id || ""}`;
}

function cardCost(entry) {
  const card = findCardData(entry.type, entry.id);
  return Number(card?.EN_cost || 0);
}

function ensureCombatStatus(player) {
  player.combat ||= {};
  player.combat.cardStress ||= { attack: "", defense: "", utility: "" };
  player.combat.usedCardTypes ||= {};
  player.combat.armorDisabledRounds = Number(player.combat.armorDisabledRounds || 0);
  player.combat.powerDisabledRounds = Number(player.combat.powerDisabledRounds || 0);
  player.combat.armorDisabledPermanent = Boolean(player.combat.armorDisabledPermanent);
  player.combat.powerDisabledPermanent = Boolean(player.combat.powerDisabledPermanent);
  return player.combat;
}

function applyCardStressCostModifiers(player, entry, cost) {
  const combat = ensureCombatStatus(player);
  const stress = combat.cardStress || {};
  let next = Number(cost || 0);
  if (entry?.type === "attack") {
    if (stress.attack === "overheat") next *= 1.8;
    if (stress.attack === "superheat" || stress.attack === "criticalHeat") next *= 2;
    if (stress.utility === "overload") next *= 0.7;
    if (stress.utility === "superload" || stress.utility === "criticalEnergy") next *= 0.85;
  }
  if (entry?.type === "defense") {
    if (stress.defense === "pressure") next += 15;
    if (stress.defense === "superpressure" || stress.defense === "criticalPhysical") next += 20;
    if (stress.attack === "overheat") next *= 0.6;
    if (stress.attack === "superheat" || stress.attack === "criticalHeat") next *= 0.8;
  }
  if (entry?.type === "utility") {
    if (stress.utility === "overload") next *= 1.5;
    if (stress.utility === "superload") next *= 2;
    if (stress.utility === "criticalEnergy") next *= 3;
    if (stress.defense === "pressure") next *= 0.6;
    if (stress.defense === "superpressure" || stress.defense === "criticalPhysical") next *= 0.8;
  }
  return Math.max(0, Math.ceil(next));
}

function cardCostForPlayer(player, entry) {
  let cost = cardCost(entry);
  if (entry?.type === "attack" && hasTalent(player, "011")) cost *= 0.6;
  if (entry?.type === "defense" && hasTalent(player, "012")) cost *= 0.6;
  if (entry?.type === "utility" && hasTalent(player, "013")) cost *= 0.6;
  if (hasTalent(player, "014")) cost *= 0.8;
  return applyCardStressCostModifiers(player, entry, cost);
}

function cardCooldown(entry) {
  const card = findCardData(entry.type, entry.id);
  return Math.max(0, Number(card?.CD || 0));
}

function shuffleDeck(items) {
  const next = [...items];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function coordKey(coord) {
  return `${coord?.[0]},${coord?.[1]}`;
}

function formatCoordForLog(coord) {
  return Array.isArray(coord) ? `(${coord[0]}, ${coord[1]})` : "-";
}

function ensureCombatEffects(player) {
  player.combat ||= {};
  player.combat.effects ||= {};
  return player.combat.effects;
}

function clearCombatEffects(player) {
  if (player.combat) player.combat.effects = {};
}

function addCoord(coord, direction, steps = 1) {
  return [Number(coord?.[0] || 0) + direction[0] * steps, Number(coord?.[1] || 0) + direction[1] * steps];
}

function axialDistance(a, b) {
  const aq = Number(a?.[0] || 0);
  const ar = Number(a?.[1] || 0);
  const bq = Number(b?.[0] || 0);
  const br = Number(b?.[1] || 0);
  return Math.max(Math.abs(aq - bq), Math.abs(ar - br), Math.abs(aq + ar - bq - br));
}

function loadMapDefinition(mapId) {
  const file = path.join(PUBLIC_DIR, "data", "maps", `map_${String(mapId || DEFAULT_MAP_ID).padStart(3, "0")}_generated.json`);
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  const cacheKey = String(mapId || DEFAULT_MAP_ID).padStart(3, "0");
  const cached = mapDefinitionCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.map;
  const map = JSON.parse(fs.readFileSync(file, "utf8"));
  mapDefinitionCache.set(cacheKey, { mtimeMs: stat.mtimeMs, map });
  return map;
}

function tileInGameInfo(tile = {}) {
  const explicitName = tile["in-game name"] || tile.in_game_name || tile.inGameName || tile.name;
  const explicitText = tile["in-game text"] || tile.in_game_text || tile.inGameText;
  if (explicitName || explicitText) {
    return { name: explicitName || tile.type || "未知", text: explicitText || tile.description || "" };
  }
  const type = String(tile.type || "").toLowerCase();
  if (type === "flame") return { name: "烈焰格子", text: "站在其上的机甲，每轮结算开始时 HP -400" };
  if (type === "base") return { name: "主基地", text: `${tile.team || ""} 的主基地`.trim() };
  if (type === "bunker") return { name: "地堡", text: `该处机甲的装甲值+${Number(tile.armor_bonus || 300)}` };
  if (type === "obstacle" || type === "wall") return { name: "高墙", text: "高墙障碍物，无法站人和穿越" };
  if (type === "spawn") return { name: "地面", text: tile.team ? `${tile.team} 出生/复活点` : "" };
  return { name: "地面", text: tile.description || "" };
}

function getMapRuntime(room) {
  if (room?._mapRuntime?.mapId === room.mapId) return room._mapRuntime.runtime;
  const map = loadMapDefinition(room.mapId);
  const tiles = new Map((map?.tiles || []).map((tile) => [coordKey(tile.coord), tile]));
  const bunkers = new Map((map?.bunkers || []).map((tile) => [coordKey(tile.coord), tile]));
  const ringIndexes = computeMapRingIndexes(map);
  const runtime = { map, tiles, bunkers, ringIndexes };
  if (room) room._mapRuntime = { mapId: room.mapId, runtime };
  return runtime;
}

function coordFromKey(key) {
  return String(key || "")
    .split(",")
    .map((item) => Number(item));
}

function computeMapRingIndexes(map) {
  const tiles = Array.isArray(map?.tiles) ? map.tiles : [];
  const remaining = new Set(tiles.map((tile) => coordKey(tile.coord)));
  const rings = new Map();
  let ring = 0;
  while (remaining.size) {
    const boundary = [];
    for (const key of remaining) {
      const coord = coordFromKey(key);
      const isBoundary = AXIAL_DIRECTIONS.some((direction) => !remaining.has(coordKey(addCoord(coord, direction))));
      if (isBoundary) boundary.push(key);
    }
    const layer = boundary.length ? boundary : Array.from(remaining);
    for (const key of layer) {
      rings.set(key, ring);
      remaining.delete(key);
    }
    ring += 1;
  }
  return rings;
}

function flameRuleForMap(map) {
  const rule = map?.special_rules?.flame_ring;
  if (!rule) return null;
  const tile = map?.special_tiles?.flame || {};
  const interval = Math.max(1, Number(rule.interval_rounds || 3));
  return {
    firstRound: Math.max(1, Number(rule.first_round || rule.start_round || interval)),
    interval,
    damage: Math.max(0, Number(rule.damage_per_turn || tile.damage_per_turn || 400)),
    eligibleTypes: Array.isArray(rule.convert_tile_types) && rule.convert_tile_types.length ? rule.convert_tile_types : ["floor", "ground", "spawn"],
    name: tile.name || "烈焰格子",
    text: tile.description || "站在其上的机甲，每轮结算开始时 HP -400",
  };
}

function flameLayerCountForRound(map, round) {
  const rule = flameRuleForMap(map);
  const currentRound = Number(round || 1);
  if (!rule || currentRound < rule.firstRound) return 0;
  return 1 + Math.floor((currentRound - rule.firstRound) / rule.interval);
}

function flameCoordsForRound(room, round = room?.battle?.round || 1) {
  const runtime = getMapRuntime(room);
  const map = runtime.map;
  const rule = flameRuleForMap(map);
  const layers = flameLayerCountForRound(map, round);
  if (!rule || layers <= 0) return [];
  const eligibleTypes = new Set(rule.eligibleTypes.map((type) => String(type || "").toLowerCase()));
  return Array.from(runtime.tiles.values())
    .filter((tile) => {
      const type = String(tile.type || "floor").toLowerCase();
      return eligibleTypes.has(type) && Number(runtime.ringIndexes.get(coordKey(tile.coord))) < layers;
    })
    .map((tile) => cloneCoord(tile.coord))
    .filter(Boolean);
}

function flameCoordSetForRound(room, round = room?.battle?.round || 1) {
  return new Set(flameCoordsForRound(room, round).map(coordKey));
}

function announceFlameRingExpansion(room) {
  const runtime = getMapRuntime(room);
  const current = flameLayerCountForRound(runtime.map, room?.battle?.round || 1);
  const previous = flameLayerCountForRound(runtime.map, Math.max(1, Number(room?.battle?.round || 1) - 1));
  if (current > previous) {
    room.battle.logs.unshift(`烈焰格子向内蔓延，地图外侧第 ${current} 圈已被点燃。`);
  }
}

function cloneCoord(coord) {
  return Array.isArray(coord) ? [Number(coord[0]), Number(coord[1])] : null;
}

function normalizeCoordInput(value) {
  if (Array.isArray(value)) return [Number(value[0]), Number(value[1])];
  if (value && value.q !== undefined) return [Number(value.q), Number(value.r)];
  return null;
}

function normalizeCoordPath(value) {
  return Array.isArray(value) ? value.map(normalizeCoordInput).filter((coord) => Array.isArray(coord)) : [];
}

function visibleCoordsForTeam(room, team) {
  room._visionCache ||= {};
  if (room._visionCache[team]) return room._visionCache[team];
  const runtime = getMapRuntime(room);
  const mapRadius = Number(runtime.map?.radius_of_view || 5);
  const sources = [];
  for (const player of battleParticipants(room)) {
    if (player.team === team && player.combat?.alive !== false && Array.isArray(player.combat?.coord)) {
      sources.push({ coord: player.combat.coord, radius: mapRadius });
    }
  }
  for (const base of Object.values(room.bases || {})) {
    if (base.team === team && Number(base.hp ?? 1) > 0 && Array.isArray(base.coord)) {
      sources.push({ coord: base.coord, radius: Number(base.visionRadius || mapRadius) });
    }
  }
  const visible = new Set();
  for (const tile of runtime.map?.tiles || []) {
    if (sources.some((source) => axialDistance(source.coord, tile.coord) <= source.radius)) {
      visible.add(coordKey(tile.coord));
    }
  }
  room._visionCache[team] = visible;
  return visible;
}

function isCoordVisibleToTeam(room, team, coord) {
  if (!Array.isArray(coord) || !team) return false;
  return visibleCoordsForTeam(room, team).has(coordKey(coord));
}

function visionByTeamSnapshot(room) {
  const teams = new Set([
    ...battleParticipants(room).map((player) => player.team).filter(Boolean),
    ...Object.values(room.bases || {}).map((base) => base.team).filter(Boolean),
  ]);
  const snapshot = {};
  for (const team of teams) {
    snapshot[team] = Array.from(visibleCoordsForTeam(room, team));
  }
  return snapshot;
}

function snapshotHasCoord(snapshot, team, coord) {
  if (!Array.isArray(coord) || !team) return false;
  const visible = snapshot?.[team];
  if (!Array.isArray(visible)) return false;
  return visible.includes(coordKey(coord));
}

function getMapBounds(mapId) {
  const map = loadMapDefinition(mapId);
  const tiles = map?.tiles || [];
  if (!tiles.length) {
    return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const tile of tiles) {
    const [q, r] = tile.coord;
    const x = Math.sqrt(3) * (q + r / 2);
    const y = 1.5 * r;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

function isWalkableCoord(room, coord) {
  const runtime = getMapRuntime(room);
  const tile = runtime.tiles.get(coordKey(coord));
  const tileType = String(tile?.type || "").toLowerCase();
  return Boolean(tile && !tile.blocking && !["obstacle", "wall", "base"].includes(tileType));
}

function isOccupiedForMovement(room, coord, movingPlayer = null) {
  const key = coordKey(coord);
  for (const base of Object.values(room.bases || {})) {
    if (coordKey(base.coord) === key && Number(base.hp ?? 1) > 0) return true;
  }
  for (const player of battleParticipants(room)) {
    if (player.username === movingPlayer?.username) continue;
    if (player.combat?.alive !== false && coordKey(player.combat?.coord) === key) return true;
  }
  return false;
}

function isMovementPassableCoord(room, coord, movingPlayer = null) {
  return isWalkableCoord(room, coord) && !isOccupiedForMovement(room, coord, movingPlayer);
}

function treasureDefinitions(room) {
  const definitions = loadMapDefinition(room.mapId)?.treasure_chests || {};
  if (Array.isArray(definitions)) return definitions;
  return Object.entries(definitions).map(([id, config]) => ({ id, type: id, ...config }));
}

function treasureEnergyAmount(treasure = {}) {
  const text = `${treasure.effect || ""} ${treasure.description || ""}`;
  return Number(text.match(/EN\s*\+\s*(\d+)/i)?.[1] || treasure.en || 0);
}

function treasureDisplay(definition = {}) {
  const type = definition.type || definition.id || "supply";
  if (String(type).includes("EN")) {
    return { name: "EN补给包", description: "效果：EN+120", en: treasureEnergyAmount(definition) || 120 };
  }
  return {
    name: definition.name || type || "补给品",
    description: definition["in-game text"] || definition.inGameText || definition.effect || "",
    en: treasureEnergyAmount(definition),
  };
}

function spawnTreasuresForRound(room, round, logs = null) {
  room.mapTreasures ||= [];
  const definitions = treasureDefinitions(room);
  if (!definitions.length) return;
  for (const definition of definitions) {
    const starts = Number(definition.starts_round || definition.startsRound || 1);
    const interval = Math.max(1, Number(definition.interval_rounds || definition.intervalRounds || 1));
    const maxOnMap = Math.max(0, Number(definition.max_on_map || definition.maxOnMap || 0));
    const currentCount = room.mapTreasures.filter((item) => String(item.type) === String(definition.type || definition.id)).length;
    if (round < starts || (round - starts) % interval !== 0 || currentCount >= maxOnMap) continue;
    const runtime = getMapRuntime(room);
    const occupiedTreasures = new Set(room.mapTreasures.map((item) => coordKey(item.coord)));
    const candidates = (runtime.map?.tiles || []).filter(
      (tile) =>
        isMovementPassableCoord(room, tile.coord, null) &&
        !occupiedTreasures.has(coordKey(tile.coord))
    );
    if (!candidates.length) continue;
    const chosen = candidates[crypto.randomInt(candidates.length)];
    const display = treasureDisplay(definition);
    const treasure = {
      id: makeId("treasure", 3),
      type: definition.type || definition.id || "supply",
      name: display.name,
      description: display.description,
      coord: cloneCoord(chosen.coord),
      en: display.en,
    };
    room.mapTreasures.push(treasure);
    logs?.unshift?.(`${treasure.name} 出现在 ${formatCoordForLog(treasure.coord)}。`);
  }
}

function collectTreasureAt(room, player, logs = null, event = null) {
  const index = (room.mapTreasures || []).findIndex((item) => coordKey(item.coord) === coordKey(player.combat?.coord));
  if (index < 0) return;
  const [treasure] = room.mapTreasures.splice(index, 1);
  const enGain = Number(treasure.en || treasureEnergyAmount(treasure) || 0);
  if (enGain > 0) {
    const before = Number(player.combat.en || 0);
    player.combat.en = Math.min(Number(player.combat.maxEN || before + enGain), before + enGain);
    logs?.push?.(`${player.nickname} 获得 ${treasure.name}，EN +${player.combat.en - before}。`);
  } else {
    logs?.push?.(`${player.nickname} 获得 ${treasure.name}。`);
  }
  event?.effects?.push?.({
    kind: "treasure",
    username: player.username,
    team: player.team,
    coord: cloneCoord(player.combat.coord),
    name: treasure.name,
    en: enGain,
  });
}

function movementLimitForCard(card) {
  return Number(String(card?.name || card?.description || card?.effect || "").match(/\d+/)?.[0] || 0);
}

function isInCloseCombat(room, player) {
  if (!Array.isArray(player?.combat?.coord)) return false;
  for (const other of battleParticipants(room)) {
    if (other.username === player.username || other.team === player.team || other.combat?.alive === false || !Array.isArray(other.combat?.coord)) continue;
    if (axialDistance(player.combat.coord, other.combat.coord) <= 1) return true;
  }
  return false;
}

function movementLimitForPlayer(room, player, card, movementKind) {
  let limit = movementLimitForCard(card);
  const close = isInCloseCombat(room, player);
  if (movementKind === "move" && hasTalent(player, "021")) limit += 1;
  if (movementKind === "charge" && hasTalent(player, "022")) limit += 1;
  const effects = ensureCombatEffects(player);
  if ((movementKind === "move" || movementKind === "charge") && Number(effects.accelMoveBonus || 0) > 0) {
    limit += Number(effects.accelMoveBonus || 0);
    effects.accelMoveBonus = 0;
  }
  if (close && (movementKind === "move" || movementKind === "charge")) {
    const closePenalty = movementKind === "charge" ? 1 : hasTalent(player, "023") ? 1 : 2;
    limit = Math.max(1, limit - closePenalty);
  }
  if (movementKind === "teleport" && close && hasTalent(player, "024")) limit = Math.max(1, limit - 1);
  return Math.max(0, limit);
}

function utilityMovementKind(card) {
  const id = String(card?.U_card_ID || "").padStart(3, "0");
  const text = `${card?.name || ""} ${card?.description || ""} ${card?.effect || ""}`;
  if (["006", "007", "008", "009"].includes(id) || text.includes("突击")) return "charge";
  if (["001", "002", "003", "004", "005"].includes(id) || text.includes("移动")) return "move";
  if (["010", "011", "012", "013"].includes(id) || text.includes("闪现")) return "teleport";
  return "";
}

function coordPixelVector(from, to) {
  const dq = Number(to?.[0] || 0) - Number(from?.[0] || 0);
  const dr = Number(to?.[1] || 0) - Number(from?.[1] || 0);
  return [Math.sqrt(3) * (dq + dr / 2), 1.5 * dr];
}

function nearestDirectionFromTo(from, to) {
  const [vx, vy] = coordPixelVector(from, to);
  const length = Math.hypot(vx, vy);
  if (!length) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const direction of AXIAL_DIRECTIONS) {
    const [dx, dy] = coordPixelVector([0, 0], direction);
    const score = (vx * dx + vy * dy) / (length * Math.hypot(dx, dy));
    if (score > bestScore) {
      bestScore = score;
      best = direction;
    }
  }
  return best;
}

function directionFromTo(from, to) {
  const distance = axialDistance(from, to);
  if (!distance) return null;
  return (
    AXIAL_DIRECTIONS.find(
      (direction) =>
        Number(to?.[0]) - Number(from?.[0]) === direction[0] * distance &&
        Number(to?.[1]) - Number(from?.[1]) === direction[1] * distance
    ) || null
  );
}

function shortestMovementPath(room, from, to, maxSteps, movingPlayer = null) {
  if (!Array.isArray(from) || !Array.isArray(to) || maxSteps < 0) return null;
  if (coordKey(from) !== coordKey(to) && !isMovementPassableCoord(room, to, movingPlayer)) return null;
  const targetKey = coordKey(to);
  const visited = new Set([coordKey(from)]);
  const queue = [{ coord: cloneCoord(from), steps: 0, path: [] }];
  while (queue.length) {
    const current = queue.shift();
    if (coordKey(current.coord) === targetKey) return current.path;
    if (current.steps >= maxSteps) continue;
    for (const direction of AXIAL_DIRECTIONS) {
      const next = addCoord(current.coord, direction);
      const key = coordKey(next);
      if (visited.has(key) || !isMovementPassableCoord(room, next, movingPlayer)) continue;
      visited.add(key);
      queue.push({ coord: next, steps: current.steps + 1, path: [...current.path, cloneCoord(next)] });
    }
  }
  return null;
}

function nearestReachableMovementPath(room, from, target, maxSteps, movingPlayer = null) {
  if (!Array.isArray(from) || !Array.isArray(target) || maxSteps < 0) return null;
  const visited = new Set([coordKey(from)]);
  const queue = [{ coord: cloneCoord(from), steps: 0, path: [] }];
  let best = null;
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length) {
      const targetDistance = axialDistance(current.coord, target);
      if (
        !best ||
        targetDistance < best.targetDistance ||
        (targetDistance === best.targetDistance && current.steps < best.steps)
      ) {
        best = {
          coord: cloneCoord(current.coord),
          path: current.path.map(cloneCoord),
          steps: current.steps,
          targetDistance,
        };
      }
    }
    if (current.steps >= maxSteps) continue;
    for (const direction of AXIAL_DIRECTIONS) {
      const next = addCoord(current.coord, direction);
      const key = coordKey(next);
      if (visited.has(key) || !isMovementPassableCoord(room, next, movingPlayer)) continue;
      visited.add(key);
      queue.push({ coord: next, steps: current.steps + 1, path: [...current.path, cloneCoord(next)] });
    }
  }
  return best;
}

function nearestTeleportDestination(room, from, target, maxSteps, movingPlayer = null) {
  const runtime = getMapRuntime(room);
  let best = null;
  for (const tile of runtime.map?.tiles || []) {
    const coord = tile.coord;
    if (axialDistance(from, coord) > maxSteps || !isMovementPassableCoord(room, coord, movingPlayer)) continue;
    const targetDistance = axialDistance(coord, target);
    const startDistance = axialDistance(from, coord);
    if (
      !best ||
      targetDistance < best.targetDistance ||
      (targetDistance === best.targetDistance && startDistance < best.startDistance)
    ) {
      best = { coord: cloneCoord(coord), targetDistance, startDistance };
    }
  }
  return best?.coord || null;
}

function resolveChargeMove(room, player, from, target, maxSteps) {
  const targetDistance = axialDistance(from, target);
  const distance = Math.max(0, Number(maxSteps || 0));
  const direction = targetDistance > 0 && distance > 0 ? directionFromTo(from, target) || nearestDirectionFromTo(from, target) : null;
  if (!direction) return { valid: false, destination: null, blocked: false };
  let destination = cloneCoord(from);
  const path = [];
  for (let step = 1; step <= distance; step += 1) {
    const next = addCoord(from, direction, step);
    if (!isMovementPassableCoord(room, next, player)) {
      return {
        valid: coordKey(destination) !== coordKey(from),
        destination,
        blocked: true,
        path,
      };
    }
    destination = next;
    path.push(cloneCoord(destination));
  }
  return { valid: true, destination, blocked: false, path };
}

function getSpawnCoord(room, team, index) {
  const map = loadMapDefinition(room.mapId);
  const spawns = map?.spawn_tiles?.[team] || [[0, 0]];
  return spawns[index % spawns.length] || spawns[0] || [0, 0];
}

function getRespawnCoord(room, team, index) {
  const map = loadMapDefinition(room.mapId);
  const respawns = map?.respawn_tiles?.[team] || map?.spawn_tiles?.[team] || [[0, 0]];
  return respawns[index % respawns.length] || respawns[0] || [0, 0];
}

function nearestFreeDeploymentCoord(room, preferredCoord, occupiedKeys = new Set()) {
  const preferredKey = coordKey(preferredCoord);
  if (Array.isArray(preferredCoord) && !occupiedKeys.has(preferredKey) && isWalkableCoord(room, preferredCoord)) {
    return preferredCoord;
  }
  const map = loadMapDefinition(room.mapId);
  const candidates = Array.from(map?.tiles?.values?.() || [])
    .map((tile) => tile.coord)
    .filter((coord) => Array.isArray(coord) && !occupiedKeys.has(coordKey(coord)) && isWalkableCoord(room, coord))
    .sort((a, b) => axialDistance(preferredCoord, a) - axialDistance(preferredCoord, b));
  return candidates[0] || preferredCoord || [0, 0];
}

function finalDeckForPlayer(player) {
  const removals = new Set(Array.isArray(player.deckRemovals) ? player.deckRemovals : []);
  return expandUnitDeck(player.selectedUnitId).filter((entry) => !removals.has(entry.key));
}

function combatantDeckRemovals(player, index) {
  if (Array.isArray(player.deckRemovalsByUnit) && Array.isArray(player.deckRemovalsByUnit[index])) {
    return player.deckRemovalsByUnit[index];
  }
  return index === 0 && Array.isArray(player.deckRemovals) ? player.deckRemovals : [];
}

function buildCombatantsForPlayer(player) {
  const pilotIds = playerPilotIds(player);
  const unitIds = playerUnitIds(player);
  const count = Math.min(pilotIds.length, unitIds.length, MAX_CONTROLLED_UNITS);
  const combatants = [];
  for (let index = 0; index < count; index += 1) {
    const pilot = findPilotData(pilotIds[index]) || {};
    const unit = findUnitData(unitIds[index]) || {};
    combatants.push({
      username: `${player.username}#${index + 1}`,
      ownerUsername: player.username,
      ownerNickname: player.nickname,
      nickname: `${player.nickname}-${index + 1}`,
      avatar: player.avatar || "",
      team: player.team,
      combatant: true,
      isAI: Boolean(player.isAI),
      aiType: player.aiType || "",
      selectedPilotId: pilotIds[index],
      selectedUnitId: unitIds[index],
      pilotName: pilot.pilot_name || pilotIds[index],
      unitName: unit.unit_name || unitIds[index],
      deckRemovals: combatantDeckRemovals(player, index),
      stats: { kills: 0, deaths: 0, assists: 0 },
    });
  }
  return combatants;
}

function makeAlternatingOrder(room) {
  const byTeam = { "Team I": [], "Team II": [] };
  for (const player of battleParticipants(room)) {
    if (byTeam[player.team]) byTeam[player.team].push(player.username);
  }
  byTeam["Team I"] = shuffleDeck(byTeam["Team I"]);
  byTeam["Team II"] = shuffleDeck(byTeam["Team II"]);
  const firstTeam = crypto.randomInt(2) === 0 ? "Team I" : "Team II";
  const secondTeam = firstTeam === "Team I" ? "Team II" : "Team I";
  const order = [];
  let i = 0;
  while (byTeam["Team I"].length || byTeam["Team II"].length) {
    for (const team of i % 2 === 0 ? [firstTeam, secondTeam] : [firstTeam, secondTeam]) {
      const next = byTeam[team].shift();
      if (next) order.push(next);
    }
    i += 1;
  }
  return order;
}

function ensureBattleStats(player) {
  player.stats ||= {};
  player.stats.kills = Number(player.stats.kills || 0);
  player.stats.deaths = Number(player.stats.deaths || 0);
  player.stats.assists = Number(player.stats.assists || 0);
  return player.stats;
}

function recordDamageContribution(targetPlayer, sourcePlayer) {
  if (!targetPlayer?.combat || !sourcePlayer?.username || targetPlayer.username === sourcePlayer.username) return;
  targetPlayer.combat.damageSources ||= {};
  targetPlayer.combat.damageSources[sourcePlayer.username] = {
    team: sourcePlayer.team,
    nickname: sourcePlayer.nickname,
  };
}

function awardDefeatStats(room, sourcePlayer, defeatedPlayer) {
  if (!defeatedPlayer?.combat || defeatedPlayer.combat.defeatCredited) return;
  defeatedPlayer.combat.defeatCredited = true;
  ensureBattleStats(defeatedPlayer).deaths += 1;
  if (!sourcePlayer || sourcePlayer.username === defeatedPlayer.username) return;
  ensureBattleStats(sourcePlayer).kills += 1;
  const contributors = Object.keys(defeatedPlayer.combat.damageSources || {});
  for (const username of contributors) {
    if (username === sourcePlayer.username || username === defeatedPlayer.username) continue;
    const contributor = findBattleParticipant(room, username);
    if (contributor?.team === sourcePlayer.team) {
      ensureBattleStats(contributor).assists += 1;
    }
  }
}

function prepareRoundActions(player) {
  player.hand = finalDeckForPlayer(player);
  player.battleDeck = [];
  player.discardPile = [];
  player.reservedCards = [];
  player.reserveKeys = [];
  player.actions = [emptyBattleAction(0)];
  player.actionConfirmed = false;
  player.nextRoundConfirmed = false;
}

function initializeBattle(room) {
  room.phase = "battle";
  room.combatants = roomPlayers(room).flatMap((player) => buildCombatantsForPlayer(player));
  room.battle = {
    round: 1,
    stage: "planning",
    drawCount: 0,
    battleDeckLimit: DEFAULT_BATTLE_DECK_LIMIT,
    actionOrder: makeAlternatingOrder(room),
    logs: ["正式战斗开始。第 1 回合行动设定。"],
    winner: "",
  };
  const teamIndexes = { "Team I": 0, "Team II": 0 };
  const occupiedDeploymentCoords = new Set();
  for (const player of battleParticipants(room)) {
    const unit = findUnitData(player.selectedUnitId) || {};
    const pilot = findPilotData(player.selectedPilotId) || {};
    const deck = finalDeckForPlayer(player);
    player.battleDeck = [];
    player.discardPile = [];
    player.hand = deck;
    player.reservedCards = [];
    player.actions = [emptyBattleAction(0)];
    player.actionConfirmed = false;
    player.nextRoundConfirmed = false;
    player.cooldowns = {};
    player.stats = { kills: 0, deaths: 0, assists: 0 };
    const spawnCoord = nearestFreeDeploymentCoord(room, getSpawnCoord(room, player.team, teamIndexes[player.team] || 0), occupiedDeploymentCoords);
    occupiedDeploymentCoords.add(coordKey(spawnCoord));
    player.combat = {
      hp: Number(unit.max_HP || 1),
      maxHP: Number(unit.max_HP || 1),
      en: unitMaxEn(unit),
      maxEN: unitMaxEn(unit),
      sp: Number(pilot.max_SP || 0),
      maxSP: Number(pilot.max_SP || 0),
      armor: Number(unit.armor || 0),
      coord: spawnCoord,
      alive: true,
      pendingKO: false,
      respawnIn: 0,
      damageSources: {},
      defeatCredited: false,
      effects: {},
      cardStress: { attack: "", defense: "", utility: "" },
      usedCardTypes: {},
      armorDisabledRounds: 0,
      armorDisabledPermanent: false,
      powerDisabledRounds: 0,
      powerDisabledPermanent: false,
    };
    teamIndexes[player.team] = (teamIndexes[player.team] || 0) + 1;
    prepareRoundActions(player);
  }
  const map = loadMapDefinition(room.mapId);
  room.bases = {};
  room.mapTreasures = [];
  for (const [team, base] of Object.entries(map?.team_bases || {})) {
    room.bases[team] = {
      team,
      coord: base.coord,
      hp: Number(base.max_HP || 10000),
      maxHP: Number(base.max_HP || 10000),
      armor: Number(base.armor || 0),
      visionRadius: Number(base.vision_radius || map?.radius_of_view || 5),
    };
  }
  spawnTreasuresForRound(room, room.battle.round, room.battle.logs);
}

function startNextBattleRound(room) {
  room._visionCache = {};
  room.battle.round += 1;
  room.battle.stage = "planning";
  room.battle.actionOrder = makeAlternatingOrder(room);
  room.battle.logs.unshift(`第 ${room.battle.round} 回合开始。`);
  announceFlameRingExpansion(room);
  for (const player of roomPlayers(room)) {
    player.actionConfirmed = false;
    player.nextRoundConfirmed = false;
  }
  const respawnIndexes = { "Team I": 0, "Team II": 0 };
  const occupiedRespawnCoords = new Set(
    battleParticipants(room)
      .filter((player) => player.combat?.alive !== false && Array.isArray(player.combat?.coord))
      .map((player) => coordKey(player.combat.coord))
  );
  for (const player of battleParticipants(room)) {
    player.nextRoundConfirmed = false;
    if (player.combat?.alive === false && player.combat.respawnIn <= 0) {
      player.combat.alive = true;
      player.combat.hp = player.combat.maxHP;
      player.combat.en = player.combat.maxEN;
      player.combat.pendingKO = false;
      const respawnCoord = nearestFreeDeploymentCoord(room, getRespawnCoord(room, player.team, respawnIndexes[player.team] || 0), occupiedRespawnCoords);
      player.combat.coord = respawnCoord;
      occupiedRespawnCoords.add(coordKey(respawnCoord));
      respawnIndexes[player.team] = (respawnIndexes[player.team] || 0) + 1;
      player.combat.damageSources = {};
      player.combat.defeatCredited = false;
      player.combat.effects = {};
      player.combat.cardStress = { attack: "", defense: "", utility: "" };
      player.combat.usedCardTypes = {};
      player.combat.armorDisabledRounds = 0;
      player.combat.armorDisabledPermanent = false;
      player.combat.powerDisabledRounds = 0;
      player.combat.powerDisabledPermanent = false;
      room.battle.logs.unshift(`${player.nickname} 已在复活点复活。`);
    }
    if (player.combat?.alive !== false) {
      player.combat.sp = Math.min(player.combat.maxSP || 999, Number(player.combat.sp || 0) + 5);
      player.combat.en = Number(player.combat.maxEN || 0);
    }
    prepareRoundActions(player);
  }
  spawnTreasuresForRound(room, room.battle.round, room.battle.logs);
  const players = battleParticipants(room);
  if (players.length && players.every((player) => player.combat?.alive === false)) {
    room.battle.logs.unshift("全员处于待复活状态，本回合自动跳过行动设定。");
    resolveBattleRound(room);
  }
}

function findHandEntry(player, key) {
  return (player.hand || []).find((entry) => entry.key === key) || null;
}

function validateBattlePlan(player, actions, reserveKeys = []) {
  const handKeys = new Set((player.hand || []).map((entry) => entry.key));
  const actionList = Array.isArray(actions) ? actions : [actions || {}];
  const cardActions = actionList.filter((action) => normalizeCardKey(action?.cardKey));
  if (cardActions.length > 1) {
    const error = new Error("同一台机甲每回合最多只能使用 1 张卡牌");
    error.status = 400;
    throw error;
  }
  const preSpiritActions = actionList.filter((action) => String(action?.preSpiritId || action?.spiritId || "").trim());
  const postSpiritActions = actionList.filter((action) => String(action?.postSpiritId || "").trim());
  if (preSpiritActions.length > 1 || postSpiritActions.length > 1) {
    const error = new Error("同一台机甲每回合同一时机只能设置 1 个精神技能");
    error.status = 400;
    throw error;
  }
  const preSpiritAction = preSpiritActions[0] || {};
  const postSpiritAction = postSpiritActions[0] || {};
  const preSpiritId = String(preSpiritAction.preSpiritId || preSpiritAction.spiritId || "").trim();
  const postSpiritId = String(postSpiritAction.postSpiritId || "").trim();
  const preSpiritTargetUsername = String(preSpiritAction.preSpiritTargetUsername || preSpiritAction.spiritTargetUsername || "").trim();
  const postSpiritTargetUsername = String(postSpiritAction.postSpiritTargetUsername || "").trim();
  let spiritCostTotal = 0;
  for (const spiritId of [preSpiritId, postSpiritId]) {
    if (spiritId && !pilotSpiritIds(player.selectedPilotId).includes(spiritId)) {
      const error = new Error("精神设定不属于当前驾驶员");
      error.status = 400;
      throw error;
    }
    if (spiritId) spiritCostTotal += Number(findSpiritData(spiritId)?.SP_cost || 0);
  }
  if (spiritCostTotal > Number(player.combat?.sp || 0)) {
    const error = new Error("精神 SP 不足，无法完成设定");
    error.status = 400;
    throw error;
  }
  const usedKeys = new Set();
  let remainingEn = Number(player.combat?.en || 0);
  const normalizedActions = [];
  for (const [index, actionSource] of actionList.entries()) {
    const cardKey = normalizeCardKey(actionSource.cardKey);
    if (!handKeys.has(cardKey)) {
      if (!cardKey) continue;
      const error = new Error("行动设定中包含不在战斗卡组里的卡牌");
      error.status = 400;
      throw error;
    }
    if (usedKeys.has(cardKey)) {
      const error = new Error("同一张卡牌副本一回合只能设定一次");
      error.status = 400;
      throw error;
    }
    usedKeys.add(cardKey);
    const entry = findHandEntry(player, cardKey);
    if (entry && Number(player.cooldowns?.[cardCooldownKey(entry)] || 0) > 0) {
      const error = new Error("冷却中的卡牌不能设定使用");
      error.status = 400;
      throw error;
    }
    const cost = cardCostForPlayer(player, entry);
    if (cost > remainingEn) {
      const error = new Error(`EN 不足，当前 ${remainingEn}，需要 ${cost}`);
      error.status = 400;
      throw error;
    }
    remainingEn -= cost;
    const targetUsername = String(actionSource.targetUsername || "").trim();
    const targetBaseTeam = String(actionSource.targetBaseTeam || "").trim();
    const targetPath = normalizeCoordPath(actionSource.targetPath || actionSource.path);
    const target = normalizeCoordInput(actionSource.target) || (targetPath.length ? cloneCoord(targetPath[targetPath.length - 1]) : null);
    normalizedActions.push({
      turn: Number(actionSource.turn ?? index),
      actorUsername: player.username,
      preSpiritId: index === 0 ? preSpiritId : "",
      preSpiritTargetUsername: index === 0 ? preSpiritTargetUsername : "",
      postSpiritId: index === 0 ? postSpiritId : "",
      postSpiritTargetUsername: index === 0 ? postSpiritTargetUsername : "",
      cardKey,
      target,
      targetPath,
      targetUsername,
      targetBaseTeam,
    });
  }
  if (!normalizedActions.length) {
    normalizedActions.push({
      ...emptyBattleAction(0),
      actorUsername: player.username,
      preSpiritId,
      preSpiritTargetUsername,
      postSpiritId,
      postSpiritTargetUsername,
    });
  }
  return {
    actions: normalizedActions,
    reserveKeys: [],
  };
}

function damageRatioFor(card, distance) {
  const ratios = String(card?.["damage ratio"] || "1.0")
    .split("/")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
  if (!ratios.length) return 1;
  return ratios[Math.min(distance, ratios.length - 1)] ?? ratios[ratios.length - 1] ?? 1;
}

function formatFormulaNumber(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function parseCardNumber(value, fallback = 0) {
  if (Number.isFinite(Number(value))) return Number(value);
  const text = String(value || "").trim();
  if (!text) return fallback;
  const parts = text.split(/[＊*xX×]/).map((part) => Number(part.trim()));
  if (parts.length > 1 && parts.every((part) => Number.isFinite(part))) {
    return parts.reduce((total, part) => total * part, 1);
  }
  const firstNumber = text.match(/-?\d+(?:\.\d+)?/);
  return firstNumber ? Number(firstNumber[0]) : fallback;
}

function cardDamageValue(card) {
  return parseCardNumber(card?.damage, 0);
}

function attackHitProfile(card) {
  const text = String(card?.damage || "").trim();
  const parts = text.split(/[＊*xX×]/).map((part) => Number(part.trim()));
  if (parts.length > 1 && parts.every((part) => Number.isFinite(part))) {
    return {
      baseDamage: parts[0],
      hitCount: Math.max(1, Math.floor(parts.slice(1).reduce((total, part) => total * part, 1))),
    };
  }
  return { baseDamage: cardDamageValue(card), hitCount: 1 };
}

function attackDamageFormula(
  card,
  armor,
  ratio,
  s1Damage,
  distance,
  modifiedDamage = null,
  attackMultiplier = 1,
  s4Damage = null,
  finalDamage = null,
  friendlyMultiplier = 1,
  baseDamageOverride = null
) {
  const baseDamage = Number(baseDamageOverride ?? cardDamageValue(card));
  const attackDamage = modifiedDamage === null ? baseDamage : Number(modifiedDamage || 0);
  const ratioText = formatFormulaNumber(ratio);
  const damageText =
    attackDamage === baseDamage
      ? formatFormulaNumber(baseDamage)
      : `${formatFormulaNumber(baseDamage)} -> ${formatFormulaNumber(attackDamage)}`;
  const attackMultiplierNumber = Number(attackMultiplier || 1);
  const s2Damage = Number(s1Damage || 0) * attackMultiplierNumber;
  const s4Value = s4Damage === null ? s2Damage : Number(s4Damage || 0);
  const multiplierText =
    attackMultiplierNumber === 1
      ? ""
      : `；攻击倍率修正：${formatFormulaNumber(s1Damage)} × ${formatFormulaNumber(attackMultiplierNumber)} = ${formatFormulaNumber(s2Damage)}`;
  const finalText = s4Damage === null ? "" : `；天赋/精神/地图修正后 S4 = ${formatFormulaNumber(s4Value)}`;
  const friendlyMultiplierNumber = Number(friendlyMultiplier || 0);
  const finalDamageBase = s4Value * friendlyMultiplierNumber;
  const friendlyText =
    friendlyMultiplierNumber === 1
      ? ""
      : `；友军伤害修正：S4 × ${formatFormulaNumber(friendlyMultiplierNumber)} = ${formatFormulaNumber(finalDamageBase)}`;
  const hpLoss = finalDamage === null ? Math.floor(Math.max(10, finalDamageBase)) : Number(finalDamage || 0);
  return `公式：S1 = (${damageText} - ${formatFormulaNumber(armor)}) × ${ratioText} = ${formatFormulaNumber(s1Damage)}${multiplierText}${finalText}${friendlyText}；HP损失 = floor(max(10, ${formatFormulaNumber(finalDamageBase)})) = ${formatFormulaNumber(hpLoss)}；距离 ${distance} 格`;
}

function resolveActionTargetCoord(room, action) {
  const targetUsername = String(action?.targetUsername || "").trim();
  if (targetUsername) {
    const targetPlayer = findBattleParticipant(room, targetUsername);
    if (targetPlayer?.combat?.alive !== false && Array.isArray(targetPlayer?.combat?.coord)) {
      return cloneCoord(targetPlayer.combat.coord);
    }
    return cloneCoord(action?.target);
  }
  const targetBaseTeam = String(action?.targetBaseTeam || "").trim();
  if (targetBaseTeam && Array.isArray(room.bases?.[targetBaseTeam]?.coord)) {
    return cloneCoord(room.bases[targetBaseTeam].coord);
  }
  return cloneCoord(action?.target);
}

function resolveGridTargetCoord(action) {
  return cloneCoord(action?.target);
}

function chance(percent) {
  return crypto.randomInt(100) < percent;
}

function attackRatiosFor(card, attacker) {
  const ratios = String(card?.["damage ratio"] || "1.0")
    .split("/")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
  const base = ratios.length ? ratios : [1];
  const isAoe = Number(card?.AOE_radius || 0) > 0;
  let next = [...base];
  if (isAoe && hasTalent(attacker, "009")) {
    next = next.map((item) => Math.min(1, item + 0.1));
  }
  if (isAoe && hasTalent(attacker, "010")) {
    next.push(0.15);
  }
  return next;
}

function damageRatioForAttack(card, distance, attacker) {
  const ratios = attackRatiosFor(card, attacker);
  return ratios[Math.min(distance, ratios.length - 1)] ?? ratios[ratios.length - 1] ?? 1;
}

function modifiedAttackDamage(player, card, logs, baseDamage = null) {
  let damage = Number(baseDamage ?? cardDamageValue(card));
  if (hasTalent(player, "001")) {
    damage *= 1.1;
    logs?.push?.(`${player.nickname} 的天赋“稳定射击”生效，武器威力 ×1.1。`);
  }
  if (hasTalent(player, "002") && chance(50)) {
    damage *= 1.2;
    logs?.push?.(`${player.nickname} 的天赋“暴击射击”触发，武器威力 ×1.2。`);
  }
  if (hasTalent(player, "003") && chance(25)) {
    damage *= 1.4;
    logs?.push?.(`${player.nickname} 的天赋“重暴射击”触发，武器威力 ×1.4。`);
  }
  return damage;
}

function modifiedTargetArmor(attacker, targetPlayer, baseArmor, logs) {
  let armor = Number(baseArmor || 0);
  if (hasTalent(attacker, "004")) {
    armor *= 0.8;
    logs?.push?.(`${attacker.nickname} 的天赋“稳定破甲”生效，目标装甲 ×0.8。`);
  }
  if (hasTalent(attacker, "005") && chance(50)) {
    armor *= 0.6;
    logs?.push?.(`${attacker.nickname} 的天赋“暴击破甲”触发，目标装甲 ×0.6。`);
  }
  if (hasTalent(attacker, "006") && chance(25)) {
    armor *= 0.2;
    logs?.push?.(`${attacker.nickname} 的天赋“重暴破甲”触发，目标装甲 ×0.2。`);
  }
  if (targetPlayer && hasTalent(targetPlayer, "007")) {
    armor *= 1.2;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“稳定防御”生效，装甲 ×1.2。`);
  }
  if (targetPlayer && hasTalent(targetPlayer, "008") && chance(50)) {
    armor *= 1.4;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“动态防御”触发，装甲 ×1.4。`);
  }
  return armor;
}

function applyFinalDamageModifiers(sourcePlayer, targetPlayer, damage, distance, logs) {
  let finalDamage = Number(damage || 0);
  if (!targetPlayer) return finalDamage;
  if (distance > 0 && hasTalent(targetPlayer, "020")) {
    finalDamage *= 0.5;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“防爆专家”生效，溅射伤害 ×0.5。`);
  }
  if (hasTalent(targetPlayer, "015")) {
    finalDamage *= 0.88;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“钢铁身躯”生效，最终伤害 ×0.88。`);
  }
  if (hasTalent(targetPlayer, "016") && chance(50)) {
    finalDamage *= 0.76;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“黑金身躯”触发，最终伤害 ×0.76。`);
  }
  if (hasTalent(targetPlayer, "017") && chance(25)) {
    finalDamage *= 0.52;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“合金身躯”触发，最终伤害 ×0.52。`);
  }
  if (hasTalent(targetPlayer, "018")) {
    finalDamage -= 400;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“稳盾抵抗”生效，最终伤害 -400。`);
  }
  if (hasTalent(targetPlayer, "019") && chance(60)) {
    finalDamage -= 650;
    logs?.push?.(`${targetPlayer.nickname} 的天赋“坚盾抵抗”触发，最终伤害 -650。`);
  }
  const targetEffects = ensureCombatEffects(targetPlayer);
  if (Number(targetEffects.ironWall || 0) > 0) {
    finalDamage *= 0.25;
    logs?.push?.(`${targetPlayer.nickname} 的精神“铁壁”生效，最终伤害 ×0.25。`);
  }
  if (Number(targetEffects.incomingDamageMultiplier || 0) > 0) {
    finalDamage *= Number(targetEffects.incomingDamageMultiplier);
    targetEffects.incomingDamageMultiplier = 0;
    logs?.push?.(`${targetPlayer.nickname} 身上的精神“分析”生效，本次最终伤害上升。`);
  }
  return Math.max(0, finalDamage);
}

function consumeNextAttackMultiplier(player, logs) {
  const effects = ensureCombatEffects(player);
  const multiplier = Number(effects.nextAttackDamageMultiplier || 0) || 1;
  if (multiplier !== 1) {
    effects.nextAttackDamageMultiplier = 1;
    logs?.push?.(`${player.nickname} 的下一次攻击伤害倍率生效：×${formatFormulaNumber(multiplier)}。`);
  }
  return multiplier;
}

function consumeSniperRangeBonus(player, logs) {
  const effects = ensureCombatEffects(player);
  const bonus = Number(effects.sniperRangeBonus || 0);
  if (bonus > 0) {
    effects.sniperRangeBonus = 0;
    logs?.push?.(`${player.nickname} 的精神“狙击”生效，射程 +${bonus}。`);
  }
  return bonus;
}

function sniperRangeBonus(player) {
  return Number(ensureCombatEffects(player).sniperRangeBonus || 0);
}

function consumeEvadeIfAny(targetPlayer, logs) {
  const effects = ensureCombatEffects(targetPlayer);
  if (Number(effects.evadeNextAttack || 0) > 0) {
    effects.evadeNextAttack = Math.max(0, Number(effects.evadeNextAttack || 0) - 1);
    logs?.push?.(`${targetPlayer.nickname} 的必闪/预见生效，闪避本次攻击。`);
    return true;
  }
  return false;
}

function hasSureHit(player) {
  return Boolean(ensureCombatEffects(player).sureHit);
}

function defenseConfig(card) {
  const id = String(card?.D_card_ID || "").padStart(3, "0");
  const name = String(card?.name || "");
  const text = `${card?.description || ""} ${card?.effect || ""}`;
  const allRound = name.includes("全轮");
  const multiplierMatch = text.match(/(?:伤害\s*)?[*×x]\s*(0?\.\d+|\d+(?:\.\d+)?)/i);
  const percentMatch = text.match(/减少\s*(\d+(?:\.\d+)?)%/);
  const evadeMatch = text.match(/(\d+(?:\.\d+)?)%\s*的概率/);
  const amountMatch = text.match(/(?:减少|格挡)[^\d]*(\d+)\s*点?伤害/);
  const beamAmountMatch = text.match(/(?:beam|光束)[\s\S]*?(?:额外)?减少\s*(\d+)\s*点?伤害/i) || text.match(/额外减少\s*(\d+)\s*点?伤害/);
  const drainEnMatch = text.match(/(?:攻击者)?\s*EN\s*减少\s*(\d+)/i);
  const multiplier = multiplierMatch
    ? Number(multiplierMatch[1])
    : percentMatch
      ? Math.max(0, 1 - Number(percentMatch[1]) / 100)
      : 0.5;
  const chancePercent = evadeMatch ? Number(evadeMatch[1]) : 50;
  const amount = amountMatch ? Number(amountMatch[1]) : 0;
  const beamAmount = beamAmountMatch ? Number(beamAmountMatch[1]) : 0;
  const drainEn = drainEnMatch ? Number(drainEnMatch[1]) : 0;
  if (id === "003" || id === "004" || name.includes("回避")) return { mode: "evade", allRound, chance: chancePercent };
  if (id === "011" || name.includes("协助")) return { mode: "assistHalve", allRound: false, multiplier };
  if (id === "031" || name.includes("电磁")) return { mode: "emShield", allRound, multiplier, amount: beamAmount };
  if (id === "032" || name.includes("地狱甲壳")) return { mode: "hellShell", allRound, amount, drainEn };
  if (amount > 0 || name.includes("盾防")) return { mode: "shield", allRound, amount };
  return { mode: "halve", allRound, multiplier };
}

function createActiveDefense(room, defender, card, action, logs) {
  const config = defenseConfig(card);
  const active = {
    cardId: String(card?.D_card_ID || ""),
    cardName: card?.name || "",
    used: false,
    ...config,
  };
  if (config.mode === "assistHalve") {
    const target = findPlayerAtCoord(room, action?.target, (player) => player.team === defender.team && player.username !== defender.username);
    if (!target || axialDistance(defender.combat?.coord, target.combat?.coord) > 1) {
      logs.push(`${defender.nickname} 的“协助防御”没有选中周围 1 格内的友方单位，发动失败。`);
      return null;
    }
    active.targetUsername = target.username;
    logs.push(`${defender.nickname} 准备替 ${target.nickname} 协助防御一次攻击。`);
  }
  return active;
}

function defenseOwnerFor(room, targetPlayer) {
  const selfDefense = targetPlayer.activeDefense;
  if (selfDefense && selfDefense.mode !== "assistHalve") {
    return { owner: targetPlayer, defense: selfDefense, receiver: targetPlayer };
  }
  for (const player of battleParticipants(room)) {
    const defense = player.activeDefense;
    if (
      player.combat?.alive &&
      defense?.mode === "assistHalve" &&
      defense.targetUsername === targetPlayer.username &&
      axialDistance(player.combat?.coord, targetPlayer.combat?.coord) <= 1
    ) {
      return { owner: player, defense, receiver: player };
    }
  }
  return null;
}

function consumeDefenseIfNeeded(owner, defense) {
  if (!defense?.allRound) {
    defense.used = true;
    if (owner) owner.activeDefense = null;
  }
}

function applyActiveDefense(room, sourcePlayer, targetPlayer, damage, logs, event, formula, attackCard) {
  const defenseInfo = defenseOwnerFor(room, targetPlayer);
  if (!defenseInfo) return { receiver: targetPlayer, damage, formula, evaded: false };
  const { owner, defense, receiver } = defenseInfo;
  let finalDamage = Math.max(0, Math.floor(damage));
  let finalFormula = formula || "";
  const cardName = defense.cardName || "防御牌";
  if (event) {
    const defenseCard = findCardData("defense", defense.cardId);
    const ownerUnit = findUnitData(owner.selectedUnitId) || {};
    event.effects.push({
      kind: "defense",
      targetKind: "player",
      username: owner.username,
      nickname: owner.nickname,
      team: owner.team,
      coord: cloneCoord(owner.combat?.coord),
      cardAnimation: defenseCard?.animation || defense.mode || "",
      cardVoice: defenseCard?.voice || "",
      unitIcon: ownerUnit.icon || ownerUnit.appearance || "",
      text: defense.mode === "evade" ? "" : "DEFEND",
    });
  }
  if (defense.mode === "evade") {
    consumeDefenseIfNeeded(owner, defense);
    if (hasSureHit(sourcePlayer)) {
      logs.push(`${sourcePlayer.nickname} 的必中效果压制了 ${owner.nickname} 的“${cardName}”。`);
      return { receiver, damage: finalDamage, formula: `${finalFormula}；${cardName}被必中压制`, evaded: false };
    }
    if (chance(Number(defense.chance || 50))) {
      logs.push(`${owner.nickname} 的“${cardName}”触发，闪避本次攻击。`);
      if (event) {
        event.effects.push({
          kind: "miss",
          targetKind: "player",
          username: targetPlayer.username,
          nickname: targetPlayer.nickname,
          team: targetPlayer.team,
          coord: cloneCoord(targetPlayer.combat?.coord),
          text: "DODGE",
        });
      }
      return { receiver, damage: 0, formula: `${finalFormula}；${cardName}闪避成功`, evaded: true };
    }
    logs.push(`${owner.nickname} 的“${cardName}”未触发。`);
    return { receiver, damage: finalDamage, formula: `${finalFormula}；${cardName}未触发`, evaded: false };
  }
  consumeDefenseIfNeeded(owner, defense);
  if (defense.mode === "assistHalve") {
    const multiplier = Number(defense.multiplier ?? 0.5);
    finalDamage = Math.floor(finalDamage * multiplier);
    finalFormula = `${finalFormula}；协助防御：floor(${damage} × ${formatFormulaNumber(multiplier)}) = ${finalDamage}，由 ${owner.nickname} 承受`;
  } else if (defense.mode === "halve") {
    const multiplier = Number(defense.multiplier ?? 0.5);
    finalDamage = Math.floor(finalDamage * multiplier);
    finalFormula = `${finalFormula}；${cardName}：floor(${damage} × ${formatFormulaNumber(multiplier)}) = ${finalDamage}`;
  } else if (defense.mode === "shield") {
    finalDamage = Math.max(0, finalDamage - Number(defense.amount || 0));
    finalFormula = `${finalFormula}；${cardName}：max(0, ${damage} - ${Number(defense.amount || 0)}) = ${finalDamage}`;
  } else if (defense.mode === "emShield") {
    const multiplier = Number(defense.multiplier ?? 0.5);
    finalDamage = Math.floor(finalDamage * multiplier);
    const pB = String(attackCard?.["P/B"] || "").toLowerCase();
    const beamBonus = pB.includes("beam") || pB.includes("光束") ? Number(defense.amount || 0) : 0;
    finalDamage = Math.max(0, finalDamage - beamBonus);
    finalFormula = `${finalFormula}；${cardName}：floor(${damage} × ${formatFormulaNumber(multiplier)})${beamBonus ? `，对光束额外 -${beamBonus}` : ""} = ${finalDamage}`;
  } else if (defense.mode === "hellShell") {
    finalDamage = Math.max(0, finalDamage - Number(defense.amount || 0));
    if (sourcePlayer?.combat) sourcePlayer.combat.en = Math.max(0, Number(sourcePlayer.combat.en || 0) - Number(defense.drainEn || 0));
    finalFormula = `${finalFormula}；${cardName}：max(0, ${damage} - ${Number(defense.amount || 0)}) = ${finalDamage}，攻击者 EN -${Number(defense.drainEn || 0)}`;
  }
  logs.push(`${owner.nickname} 的“${cardName}”生效。`);
  return { receiver, damage: finalDamage, formula: finalFormula, evaded: false };
}

function unitArmorAt(room, player) {
  const combat = ensureCombatStatus(player);
  if (combat.armorDisabledPermanent || Number(combat.armorDisabledRounds || 0) > 0) return 0;
  const runtime = getMapRuntime(room);
  const bunker = runtime.bunkers.get(coordKey(player.combat?.coord));
  return Number(player.combat?.armor || 0) + Number(bunker?.armor_bonus || 0);
}

function cardPublicData(entry) {
  const card = findCardData(entry?.type, entry?.id) || {};
  return {
    cardKey: entry?.key || "",
    cardType: entry?.type || "",
    cardId: entry?.id || "",
    cardName: card.name || entry?.id || "",
    cardImage: card.card_picture || "",
    cardAnimation: card.animation || "",
    cardVoice: card.voice || "",
  };
}

function publicActionData(player, entry, turn, extra = {}) {
  const pilot = findPilotData(player.selectedPilotId) || {};
  const unit = findUnitData(player.selectedUnitId) || {};
  return {
    turn: Number(turn || 0) + 1,
    username: player.username,
    nickname: player.nickname,
    team: player.team,
    pilotId: player.selectedPilotId || "",
    pilotName: pilot.pilot_name || pilot.name || "",
    pilotFace: pilot.face || "",
    unitId: player.selectedUnitId || "",
    unitName: unit.unit_name || unit.name || "",
    unitIcon: unit.icon || unit.appearance || "",
    ...cardPublicData(entry),
    ...extra,
  };
}

function makeResolutionEvent(room, type, player, entry, action, turn, extra = {}) {
  room.battle.resolutionSeq = Number(room.battle.resolutionSeq || 0) + 1;
  return {
    id: `event_${room.battle.round}_${room.battle.resolutionSeq}`,
    type,
    turn: Number(turn || 0) + 1,
    actorTeam: player.team,
    actorCoord: cloneCoord(player.combat?.coord),
    targetCoord: cloneCoord(action?.target),
    publicAction: publicActionData(player, entry, turn, extra.publicAction || {}),
    effects: [],
    result: extra.result || "",
    visionByTeam: room.simulationFast ? null : visionByTeamSnapshot(room),
  };
}

function addResolutionEvent(room, event) {
  if (room.simulationFast) return;
  room.battle.resolutionEvents ||= [];
  room.battle.resolutionEvents.push(event);
}

function viewerEventForTeam(room, event, team) {
  const visionSnapshot = event.visionByTeam || null;
  const coordVisibleForViewer = (coord) =>
    visionSnapshot ? snapshotHasCoord(visionSnapshot, team, coord) : isCoordVisibleToTeam(room, team, coord);
  const actorVisible = event.actorTeam === team || coordVisibleForViewer(event.actorCoord);
  const targetVisible = coordVisibleForViewer(event.targetCoord);
  const effects = (event.effects || []).map((effect) => {
    const sameTeam = effect.team === team || effect.actorTeam === team;
    const coordVisible = coordVisibleForViewer(effect.coord);
    const fromVisible = coordVisibleForViewer(effect.from);
    const toVisible = coordVisibleForViewer(effect.to);
    const effectArea = normalizeCoordPath(effect.area);
    const visibleArea = sameTeam ? effectArea : effectArea.filter((coord) => coordVisibleForViewer(coord));
    const visible = sameTeam || coordVisible || fromVisible || toVisible || visibleArea.length > 0;
    if (!visible) {
      return { kind: effect.kind, visible: false, targetKind: effect.targetKind || "" };
    }
    const effectPath = normalizeCoordPath(effect.path);
    const pathVisible = sameTeam || effectPath.every((coord) => coordVisibleForViewer(coord));
    return {
      ...effect,
      visible: true,
      coord: sameTeam || coordVisible ? cloneCoord(effect.coord) : null,
      from: sameTeam || fromVisible ? cloneCoord(effect.from) : null,
      to: sameTeam || toVisible ? cloneCoord(effect.to) : null,
      path: pathVisible ? effectPath : [],
      area: visibleArea.map(cloneCoord),
    };
  });
  return {
    id: event.id,
    type: event.type,
    turn: event.turn,
    result: event.result || "",
    publicAction: event.publicAction,
    animation: {
      actorVisible,
      actorCoord: actorVisible ? cloneCoord(event.actorCoord) : null,
      targetVisible,
      targetCoord: targetVisible ? cloneCoord(event.targetCoord) : null,
      beamMode: actorVisible && targetVisible ? "direct" : targetVisible ? "incoming" : actorVisible ? "outgoing" : "hidden",
      visibleCoords: Array.isArray(visionSnapshot?.[team]) ? visionSnapshot[team] : [],
      effects,
    },
  };
}

function resolutionEventsForViewer(room, viewerPlayer) {
  if (isObserverPlayer(viewerPlayer) && room.mode === "ai_sim") {
    const allVisible = new Set();
    const map = loadMapDefinition(room.mapId);
    for (const tile of map?.tiles || []) allVisible.add(coordKey(tile.coord));
    return (room.battle?.resolutionEvents || []).map((event) => viewerEventForTeam(room, { ...event, visionByTeam: { Observer: Array.from(allVisible) } }, "Observer"));
  }
  if (!viewerPlayer?.team) return [];
  return (room.battle?.resolutionEvents || []).map((event) => viewerEventForTeam(room, event, viewerPlayer.team));
}

function applyDamage(room, sourcePlayer, target, amount, logs, event = null, formula = "", attackCard = null) {
  const damage = Math.max(0, Math.floor(amount));
  if (damage <= 0) return { hit: false, evaded: false, damage: 0 };
  if (target.kind === "player") {
    const targetPlayer = target.player;
    if (!targetPlayer.combat?.alive) return { hit: false, evaded: false, damage: 0 };
    const defended = applyActiveDefense(room, sourcePlayer, targetPlayer, damage, logs, event, formula, attackCard);
    if (defended.evaded) return { hit: false, evaded: true, damage: 0, player: targetPlayer };
    const player = defended.receiver || targetPlayer;
    if (!player.combat?.alive) return { hit: false, evaded: false, damage: 0, player };
    let finalDamage = Math.max(0, Math.floor(defended.damage || 0));
    let finalFormula = defended.formula || formula;
    const hpBefore = Number(player.combat.hp || 1);
    if (finalDamage <= 0) {
      if (event) {
        event.effects.push({
          kind: "damage",
          targetKind: "player",
          username: player.username,
          nickname: player.nickname,
          team: player.team,
          coord: cloneCoord(player.combat.coord),
          damage: 0,
          hpBefore,
          hpAfter: Number(player.combat.hp || 0),
          pendingKO: Boolean(player.combat.pendingKO),
        });
      }
      logs.push(`${sourcePlayer.nickname} 对 ${player.nickname} 造成 0 伤害${finalFormula ? `（${finalFormula}）` : ""}。`);
      return { hit: true, evaded: false, damage: 0, player };
    }
    recordDamageContribution(player, sourcePlayer);
    player.combat.hp = Math.max(1, Number(player.combat.hp || 1) - finalDamage);
    if (Number(player.combat.hp || 0) <= 1 && !player.combat.pendingKO) {
      const effects = ensureCombatEffects(player);
      if (Number(effects.guts || 0) > 0) {
        effects.guts = 0;
        player.combat.hp = Math.max(10, Number(player.combat.hp || 0));
        logs.push(`${player.nickname} 的精神“底力”生效，HP 固定为 10，本回合不会被击坠。`);
      } else {
        player.combat.pendingKO = true;
        awardDefeatStats(room, sourcePlayer, player);
        logs.push(`${player.nickname} 即将被击坠，本回合仍以 1HP 继续行动。`);
      }
    }
    if (event) {
      event.effects.push({
        kind: "damage",
        targetKind: "player",
        username: player.username,
        nickname: player.nickname,
        team: player.team,
        coord: cloneCoord(player.combat.coord),
        damage: finalDamage,
        hpBefore,
        hpAfter: Number(player.combat.hp || 0),
        pendingKO: Boolean(player.combat.pendingKO),
      });
    }
    logs.push(`${sourcePlayer.nickname} 对 ${player.nickname} 造成 ${finalDamage} 伤害${finalFormula ? `（${finalFormula}）` : ""}。`);
    return { hit: true, evaded: false, damage: finalDamage, player };
  }
  if (target.kind === "base") {
    const hpBefore = Number(target.base.hp || 0);
    target.base.hp = Math.max(0, Number(target.base.hp || 0) - damage);
    if (event) {
      event.effects.push({
        kind: "damage",
        targetKind: "base",
        team: target.base.team,
        coord: cloneCoord(target.base.coord),
        damage,
        hpBefore,
        hpAfter: Number(target.base.hp || 0),
        destroyed: target.base.hp <= 0,
      });
    }
    logs.push(`${sourcePlayer.nickname} 对 ${target.base.team} 基地造成 ${damage} 伤害${formula ? `（${formula}）` : ""}。`);
    if (target.base.hp <= 0 && !room.battle.winner) {
      room.battle.winner = sourcePlayer.team;
      logs.push(`${sourcePlayer.team} 摧毁敌方基地，获得胜利。`);
    }
    return { hit: true, evaded: false, damage, base: target.base };
  }
  return { hit: false, evaded: false, damage: 0 };
}

function collectTargetsAt(room, coord, radius) {
  const targets = [];
  for (const player of battleParticipants(room)) {
    if (player.combat?.alive && axialDistance(player.combat.coord, coord) <= radius) {
      targets.push({ kind: "player", player, distance: axialDistance(player.combat.coord, coord) });
    }
  }
  for (const base of Object.values(room.bases || {})) {
    if (axialDistance(base.coord, coord) <= radius) {
      targets.push({ kind: "base", base, distance: axialDistance(base.coord, coord) });
    }
  }
  return targets;
}

function isFriendlyAttackTarget(sourcePlayer, target) {
  if (!sourcePlayer?.team || !target) return false;
  if (target.kind === "player") return target.player?.team === sourcePlayer.team;
  if (target.kind === "base") return target.base?.team === sourcePlayer.team;
  return false;
}

function friendlyAttackMultiplier(room, sourcePlayer, target) {
  if (!isFriendlyAttackTarget(sourcePlayer, target)) return 1;
  const mode = normalizeRules(room.rules).friendlyAttackEffect;
  if (mode === "immune") return 0;
  if (mode === "half") return 0.5;
  return 1;
}

function attackAreaCoords(room, coord, radius) {
  if (!Array.isArray(coord)) return [];
  const runtime = getMapRuntime(room);
  const coords = [cloneCoord(coord)];
  for (const tileCoord of Array.from(runtime.tiles.values())
    .map((tile) => tile.coord)
    .filter((tileCoord) => axialDistance(tileCoord, coord) <= radius)
    .map(cloneCoord)) {
    if (!coords.some((item) => coordKey(item) === coordKey(tileCoord))) coords.push(tileCoord);
  }
  return coords;
}

function nearestFreeAdjacentCoord(room, from, center, movingPlayer) {
  if (!Array.isArray(from) || !Array.isArray(center)) return null;
  const candidates = AXIAL_DIRECTIONS.map((direction) => addCoord(center, direction))
    .filter((coord) => isMovementPassableCoord(room, coord, movingPlayer))
    .sort((a, b) => {
      const distanceDiff = axialDistance(from, a) - axialDistance(from, b);
      if (distanceDiff) return distanceDiff;
      return coordKey(a).localeCompare(coordKey(b));
    });
  return candidates[0] ? cloneCoord(candidates[0]) : null;
}

function applyAttackPreMove(room, player, card, targetCoord, logs, event) {
  const cardId = String(card?.A_card_ID || "").padStart(3, "0");
  const text = `${card?.name || ""} ${card?.effect || ""}`;
  const shouldBlinkAdjacent = cardId === "053" || (text.includes("闪现") && text.includes("相邻"));
  if (!shouldBlinkAdjacent) return;
  const targetPlayer = findPlayerAtCoord(room, targetCoord);
  if (!targetPlayer || targetPlayer.username === player.username) return;
  const from = cloneCoord(player.combat?.coord);
  const destination = nearestFreeAdjacentCoord(room, from, targetPlayer.combat?.coord, player);
  if (!destination || coordKey(destination) === coordKey(from)) return;
  player.combat.coord = destination;
  logs.push(`${player.nickname} 发动${card.name || "攻击"}的特殊效果，闪现至 ${targetPlayer.nickname} 相邻格 ${formatCoordForLog(destination)}。`);
  event?.effects?.push?.({
    kind: "move",
    username: player.username,
    nickname: player.nickname,
    team: player.team,
    from,
    to: cloneCoord(destination),
    path: [cloneCoord(destination)],
    cardAnimation: "闪现",
    cardVoice: card.voice || "",
  });
}

function applyAttackPostHitMove(room, player, card, targetPlayer, originalTargetCoord, logs, event) {
  const cardId = String(card?.A_card_ID || "").padStart(3, "0");
  const text = `${card?.name || ""} ${card?.effect || ""}`;
  const shouldPullAdjacent = cardId === "054" || (text.includes("强制移动") && text.includes("相邻"));
  if (!shouldPullAdjacent || !targetPlayer?.combat?.alive || targetPlayer.team === player.team) return;
  const from = cloneCoord(targetPlayer.combat?.coord);
  const destination = nearestFreeAdjacentCoord(room, originalTargetCoord || from, player.combat?.coord, targetPlayer);
  if (!destination || coordKey(destination) === coordKey(from)) return;
  targetPlayer.combat.coord = destination;
  logs.push(`${player.nickname} 发动${card.name || "攻击"}的特殊效果，将 ${targetPlayer.nickname} 拉拽至相邻格 ${formatCoordForLog(destination)}。`);
  event?.effects?.push?.({
    kind: "move",
    username: targetPlayer.username,
    nickname: targetPlayer.nickname,
    team: targetPlayer.team,
    from,
    to: cloneCoord(destination),
    path: [cloneCoord(destination)],
    cardAnimation: card.animation || "移动",
    cardVoice: card.voice || "",
  });
}

function executeAttack(room, player, entry, action, logs, event) {
  const card = findCardData("attack", entry.id);
  const targetCoord = resolveGridTargetCoord(action);
  if (!card || !targetCoord) {
    logs.push(`${player.nickname} 的攻击没有有效目标，跳过。`);
    if (event) event.result = "invalid";
    return;
  }
  if (event) event.targetCoord = cloneCoord(targetCoord);
  const range = axialDistance(player.combat.coord, targetCoord);
  const minRange = Number(card.min_range || 0);
  const maxRange = Number(card.max_range || 0) + sniperRangeBonus(player);
  if (range < minRange || range > maxRange) {
    logs.push(`${player.nickname} 的 ${card.name} 目标超出射程，跳过。`);
    if (event) event.result = "out-of-range";
    return;
  }
  consumeSniperRangeBonus(player, logs);
  applyAttackPreMove(room, player, card, targetCoord, logs, event);
  const baseRadius = Math.max(0, Number(card.AOE_radius || 0));
  const radius = baseRadius + (baseRadius > 0 && hasTalent(player, "010") ? 1 : 0);
  if (event) {
    event.effects.push({
      kind: "attack-area",
      actorTeam: player.team,
      team: player.team,
      coord: cloneCoord(targetCoord),
      area: attackAreaCoords(room, targetCoord, radius),
    });
  }
  const hitProfile = attackHitProfile(card);
  const attackDamage = modifiedAttackDamage(player, card, logs, hitProfile.baseDamage);
  const attackDamageMultiplier = consumeNextAttackMultiplier(player, logs);
  let hitCount = 0;
  const attackTargets = collectTargetsAt(room, targetCoord, radius).filter(
    (target) => !(target.kind === "player" && target.player.username === player.username)
  );
  if (!attackTargets.length) {
    logs.push(`${player.nickname} 的 ${card.name || "攻击"} 打在空格上。`);
    if (event) event.result = "empty";
    return;
  }
  for (const target of attackTargets) {
    const friendlyMultiplier = friendlyAttackMultiplier(room, player, target);
    if (friendlyMultiplier <= 0) {
      if (event) {
        const coord = target.kind === "player" ? target.player.combat.coord : target.base.coord;
        const hp = target.kind === "player" ? Number(target.player.combat.hp || 0) : Number(target.base.hp || 0);
        event.effects.push({
          kind: "damage",
          targetKind: target.kind,
          username: target.kind === "player" ? target.player.username : "",
          nickname: target.kind === "player" ? target.player.nickname : target.base.team,
          team: target.kind === "player" ? target.player.team : target.base.team,
          coord: cloneCoord(coord),
          damage: 0,
          hpBefore: hp,
          hpAfter: hp,
          text: "FRIEND",
        });
      }
      logs.push(`${player.nickname} 的 ${card.name || "攻击"} 命中友军，但房间规则使其免受伤害。`);
      continue;
    }
    if (target.kind === "player" && consumeEvadeIfAny(target.player, logs)) {
      if (event) {
        event.effects.push({
          kind: "miss",
          targetKind: "player",
          username: target.player.username,
          nickname: target.player.nickname,
          team: target.player.team,
          coord: cloneCoord(target.player.combat.coord),
          text: "DODGE",
        });
      }
      continue;
    }
    let pulledAfterHit = false;
    for (let hitIndex = 0; hitIndex < hitProfile.hitCount; hitIndex += 1) {
      const baseArmor = target.kind === "player" ? unitArmorAt(room, target.player) : Number(target.base.armor || 0);
      const armor = target.kind === "player" ? modifiedTargetArmor(player, target.player, baseArmor, logs) : baseArmor;
      const ratio = damageRatioForAttack(card, target.distance, player);
      const s1Damage = (attackDamage - armor) * ratio;
      let damageBeforeMinimum = s1Damage * attackDamageMultiplier;
      if (target.kind === "player") {
        damageBeforeMinimum = applyFinalDamageModifiers(player, target.player, damageBeforeMinimum, target.distance, logs);
      }
      const adjustedDamageBase = damageBeforeMinimum * friendlyMultiplier;
      const damage = Math.floor(Math.max(10, adjustedDamageBase));
      const formulaPrefix = hitProfile.hitCount > 1 ? `第${hitIndex + 1}/${hitProfile.hitCount}段；` : "";
      const formula =
        formulaPrefix +
        attackDamageFormula(
          card,
          armor,
          ratio,
          s1Damage,
          target.distance,
          attackDamage,
          attackDamageMultiplier,
          damageBeforeMinimum,
          damage,
          friendlyMultiplier,
          hitProfile.baseDamage
        );
      const damageResult = applyDamage(room, player, target, damage, logs, event, formula, card);
      if (damageResult?.hit) {
        hitCount += 1;
        if (!pulledAfterHit && damageResult.player) {
          applyAttackPostHitMove(room, player, card, damageResult.player, targetCoord, logs, event);
          pulledAfterHit = true;
        }
      }
    }
  }
  if (event) event.result = hitCount ? "hit" : "miss";
}

function executeUtility(room, player, entry, action, logs, event) {
  const card = findCardData("utility", entry.id);
  const targetCoord = resolveActionTargetCoord(room, action);
  if (!card || !targetCoord) {
    logs.push(`${player.nickname} 的通用牌没有有效目标，跳过。`);
    if (event) event.result = "invalid";
    return;
  }
  const movementKind = utilityMovementKind(card);
  if (movementKind) {
    const combat = ensureCombatStatus(player);
    if (combat.powerDisabledPermanent || Number(combat.powerDisabledRounds || 0) > 0) {
      logs.push(`${player.nickname} 处于动力失效状态，${card.name || "位移牌"}发动失败。`);
      if (event) event.result = "invalid";
      return;
    }
    const from = cloneCoord(player.combat.coord);
    const limit = movementLimitForPlayer(room, player, card, movementKind);
    let destination = null;
    let blocked = false;
    let movementPath = [];

    if (movementKind === "charge") {
      const charge = resolveChargeMove(room, player, from, targetCoord, limit);
      destination = charge.destination;
      blocked = charge.blocked;
      movementPath = Array.isArray(charge.path) ? charge.path.map(cloneCoord) : [];
      if (!charge.valid) destination = null;
    } else if (movementKind === "move") {
      const shortestPath = shortestMovementPath(room, from, targetCoord, limit, player);
      if (shortestPath) {
        destination = cloneCoord(targetCoord);
        movementPath = shortestPath;
      } else {
        const nearest = nearestReachableMovementPath(room, from, targetCoord, limit, player);
        if (nearest) {
          destination = nearest.coord;
          movementPath = nearest.path;
        }
      }
    } else if (movementKind === "teleport") {
      if (isInCloseCombat(room, player) && !hasTalent(player, "024")) {
        destination = null;
      } else {
        destination = nearestTeleportDestination(room, from, targetCoord, limit, player);
      }
      if (destination) {
        movementPath = [cloneCoord(destination)];
      }
    }

    if (destination) {
      player.combat.coord = destination;
      if (event) {
        event.result = "move";
        event.effects.push({
          kind: "move",
          actorTeam: player.team,
          username: player.username,
          team: player.team,
          from,
          to: cloneCoord(destination),
          path: movementPath,
        });
      }
      logs.push(
        blocked
          ? `${player.nickname} 的${card.name}途中受阻，停在 (${destination[0]}, ${destination[1]})。`
          : `${player.nickname} 移动到 (${destination[0]}, ${destination[1]})。`
      );
      collectTreasureAt(room, player, logs, event);
    } else {
      logs.push(
        movementKind === "charge"
          ? `${player.nickname} 的${card.name}突击路线无效或起步受阻，跳过。`
          : `${player.nickname} 的移动目标无法通过无障碍路线抵达，跳过。`
      );
      if (event) event.result = "invalid";
    }
    return;
  }
  if (event) {
    event.result = "utility";
    event.effects.push({
      kind: "utility",
      actorTeam: player.team,
      username: player.username,
      team: player.team,
      coord: cloneCoord(targetCoord),
    });
  }
  logs.push(`${player.nickname} 使用 ${card.name || "通用牌"}。`);
}

function findPlayerAtCoord(room, coord, predicate = () => true) {
  if (!Array.isArray(coord)) return null;
  return battleParticipants(room).find(
    (player) => player.combat?.alive !== false && coordKey(player.combat?.coord) === coordKey(coord) && predicate(player)
  ) || null;
}

function findPlayerByUsername(room, username, predicate = () => true) {
  const player = findBattleParticipant(room, username);
  if (!player || player.combat?.alive === false || !predicate(player)) return null;
  return player;
}

function spiritTargetPlayer(room, caster, action, mode) {
  if (mode === "self") return caster;
  const target = findPlayerByUsername(room, action?.spiritTargetUsername, (player) => {
    if (mode === "ally") return player.team === caster.team;
    if (mode === "enemy") return player.team !== caster.team;
    return true;
  });
  return target || (mode === "ally" ? caster : null);
}

function addSpiritEffectEvent(event, target, spirit, extra = {}) {
  event.effects.push({
    kind: "spirit",
    targetKind: "player",
    username: target.username,
    nickname: target.nickname,
    team: target.team,
    coord: cloneCoord(target.combat?.coord),
    spiritId: spirit?.spirit_ID || "",
    spiritName: spirit?.name || "",
    ...extra,
  });
}

function healPlayer(target, amount) {
  const before = Number(target.combat?.hp || 0);
  target.combat.hp = Math.min(Number(target.combat.maxHP || before + amount), before + amount);
  return target.combat.hp - before;
}

function restoreEn(target, amount) {
  const before = Number(target.combat?.en || 0);
  target.combat.en = Math.min(Number(target.combat.maxEN || before + amount), before + amount);
  return target.combat.en - before;
}

function applySpirit(room, caster, spirit, action, logs, event) {
  const id = String(spirit?.spirit_ID || "").padStart(3, "0");
  let target = caster;
  let amount = 0;
  switch (id) {
    case "001":
      ensureCombatEffects(caster).sureHit = true;
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 获得“必中”：本回合攻击不会受普通闪避影响。`);
      return true;
    case "002":
      ensureCombatEffects(caster).evadeNextAttack = Number(ensureCombatEffects(caster).evadeNextAttack || 0) + 1;
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 获得“必闪”：下一次遭受攻击时闪避。`);
      return true;
    case "003":
      ensureCombatEffects(caster).nextAttackDamageMultiplier = (Number(ensureCombatEffects(caster).nextAttackDamageMultiplier || 0) || 1) * 2;
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 获得“热血”：下一次攻击最终伤害 ×2。`);
      return true;
    case "004":
      ensureCombatEffects(caster).ironWall = 1;
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 获得“铁壁”：本回合所受最终伤害 ×0.25。`);
      return true;
    case "005":
      target = spiritTargetPlayer(room, caster, action, "ally");
      ensureCombatEffects(target).sureHit = true;
      addSpiritEffectEvent(event, target, spirit);
      logs.push(`${caster.nickname} 对 ${target.nickname} 使用“感应”：其本回合攻击获得必中效果。`);
      return true;
    case "006":
      target = spiritTargetPlayer(room, caster, action, "ally");
      amount = healPlayer(target, 2500);
      addSpiritEffectEvent(event, target, spirit, { hp: amount });
      logs.push(`${caster.nickname} 对 ${target.nickname} 使用“毅力”：HP +${amount}。`);
      return true;
    case "007":
      target = spiritTargetPlayer(room, caster, action, "ally");
      amount = healPlayer(target, 4000);
      addSpiritEffectEvent(event, target, spirit, { hp: amount });
      logs.push(`${caster.nickname} 对 ${target.nickname} 使用“友情”：HP +${amount}。`);
      return true;
    case "008":
      target = spiritTargetPlayer(room, caster, action, "ally");
      amount = restoreEn(target, 150);
      addSpiritEffectEvent(event, target, spirit, { en: amount });
      logs.push(`${caster.nickname} 对 ${target.nickname} 使用“补给”：EN +${amount}。`);
      return true;
    case "009":
      target = spiritTargetPlayer(room, caster, action, "ally");
      ensureCombatEffects(target).nextAttackDamageMultiplier = (Number(ensureCombatEffects(target).nextAttackDamageMultiplier || 0) || 1) * 1.5;
      addSpiritEffectEvent(event, target, spirit);
      logs.push(`${caster.nickname} 对 ${target.nickname} 使用“激励”：其下一次攻击最终伤害 ×1.5。`);
      return true;
    case "010":
      ensureCombatEffects(caster).guts = 1;
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 获得“底力”：本回合下一次被击坠时保留 10HP。`);
      return true;
    case "011":
      ensureCombatEffects(caster).sniperRangeBonus = Number(ensureCombatEffects(caster).sniperRangeBonus || 0) + 3;
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 获得“狙击”：下一次攻击射程 +3。`);
      return true;
    case "012":
      ensureCombatEffects(caster).accelMoveBonus = Number(ensureCombatEffects(caster).accelMoveBonus || 0) + 3;
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 获得“加速”：下一次移动/突击距离 +3。`);
      return true;
    case "013":
      target = spiritTargetPlayer(room, caster, action, "enemy");
      if (!target) {
        logs.push(`${caster.nickname} 的“分析”没有有效敌方目标，发动失败。`);
        event.result = "invalid";
        return false;
      }
      ensureCombatEffects(target).incomingDamageMultiplier = (Number(ensureCombatEffects(target).incomingDamageMultiplier || 0) || 1) * 1.25;
      addSpiritEffectEvent(event, target, spirit);
      logs.push(`${caster.nickname} 对 ${target.nickname} 使用“分析”：其下一次受到攻击最终伤害 ×1.25。`);
      return true;
    case "014":
      target = spiritTargetPlayer(room, caster, action, "ally");
      ensureCombatEffects(target).evadeNextAttack = Number(ensureCombatEffects(target).evadeNextAttack || 0) + 1;
      addSpiritEffectEvent(event, target, spirit);
      logs.push(`${caster.nickname} 对 ${target.nickname} 使用“预见”：其下一次遭受攻击时闪避。`);
      return true;
    default:
      addSpiritEffectEvent(event, caster, spirit);
      logs.push(`${caster.nickname} 发动精神：${spirit?.name || id}。`);
      return true;
  }
}

function cardUseSucceeded(entry, event) {
  if (!entry || !event) return false;
  if (["invalid", "out-of-range", "no-en"].includes(event.result)) return false;
  return true;
}

function applyStatusSelfDamage(room, player, ratio, logs, event, label) {
  if (!player?.combat?.alive || Number(ratio || 0) <= 0) return;
  const hpBefore = Number(player.combat.hp || 1);
  const damage = Math.max(1, Math.floor(Number(player.combat.maxHP || hpBefore) * Number(ratio)));
  player.combat.hp = Math.max(1, hpBefore - damage);
  if (Number(player.combat.hp || 0) <= 1 && !player.combat.pendingKO) {
    const effects = ensureCombatEffects(player);
    if (Number(effects.guts || 0) > 0) {
      effects.guts = 0;
      player.combat.hp = Math.max(10, Number(player.combat.hp || 0));
      logs.push(`${player.nickname} 的精神“底力”生效，HP 固定为 10，本回合不会被击坠。`);
    } else {
      player.combat.pendingKO = true;
      awardDefeatStats(room, null, player);
      logs.push(`${player.nickname} 因“${label}”损伤，即将被击坠。`);
    }
  }
  event?.effects?.push?.({
    kind: "damage",
    targetKind: "player",
    username: player.username,
    nickname: player.nickname,
    team: player.team,
    coord: cloneCoord(player.combat.coord),
    damage,
    hpBefore,
    hpAfter: Number(player.combat.hp || 0),
    pendingKO: Boolean(player.combat.pendingKO),
    text: label,
  });
  logs.push(`${player.nickname} 受到“${label}”反噬，HP -${damage}。`);
}

function recordSuccessfulCardUse(room, player, entry, logs, event) {
  const combat = ensureCombatStatus(player);
  combat.usedCardTypes[entry.type] = true;
  if (entry.type === "attack") {
    if (combat.cardStress.attack === "superheat") applyStatusSelfDamage(room, player, 0.2, logs, event, "武器超热");
    if (combat.cardStress.attack === "criticalHeat") applyStatusSelfDamage(room, player, 1, logs, event, "高温临界");
  }
}

function nextStressValue(current, used, chain) {
  if (!used) return "";
  if (current === chain[0]) return chain[1];
  if (current === chain[1]) return chain[2];
  if (current === chain[2]) return chain[2];
  return chain[0];
}

function advanceCardStressForNextRound(player) {
  const combat = ensureCombatStatus(player);
  const used = combat.usedCardTypes || {};
  const current = combat.cardStress || {};
  if (Number(combat.armorDisabledRounds || 0) > 0) combat.armorDisabledRounds = Math.max(0, Number(combat.armorDisabledRounds || 0) - 1);
  if (Number(combat.powerDisabledRounds || 0) > 0) combat.powerDisabledRounds = Math.max(0, Number(combat.powerDisabledRounds || 0) - 1);

  const nextDefense = nextStressValue(current.defense, used.defense, ["pressure", "superpressure", "criticalPhysical"]);
  const nextUtility = nextStressValue(current.utility, used.utility, ["overload", "superload", "criticalEnergy"]);
  if (used.defense && current.defense === "superpressure") combat.armorDisabledRounds = Math.max(combat.armorDisabledRounds, 1);
  if (used.defense && current.defense === "criticalPhysical") combat.armorDisabledPermanent = true;
  if (used.utility && current.utility === "superload") combat.powerDisabledRounds = Math.max(combat.powerDisabledRounds, 1);
  if (used.utility && current.utility === "criticalEnergy") combat.powerDisabledPermanent = true;

  combat.cardStress = {
    attack: nextStressValue(current.attack, used.attack, ["overheat", "superheat", "criticalHeat"]),
    defense: nextDefense,
    utility: nextUtility,
  };
  combat.usedCardTypes = {};
}

function executeCard(room, player, entry, action, logs, turn = 0) {
  if (!player.combat?.alive) return;
  if (!entry) return;
  const event = makeResolutionEvent(room, entry.type, player, entry, action, turn);
  const cost = cardCostForPlayer(player, entry);
  if (Number(player.combat.en || 0) < cost) {
    logs.push(`${player.nickname} EN 不足，无法使用卡牌。`);
    event.result = "no-en";
    addResolutionEvent(room, event);
    return;
  }
  player.combat.en = Math.max(0, Number(player.combat.en || 0) - cost);
  if (entry.type === "attack") executeAttack(room, player, entry, action, logs, event);
  if (entry.type === "utility") executeUtility(room, player, entry, action, logs, event);
  if (entry.type === "defense") {
    const card = findCardData("defense", entry.id);
    const activeDefense = createActiveDefense(room, player, card, action, logs);
    if (!activeDefense) {
      player.combat.en = Math.min(player.combat.maxEN || 0, Number(player.combat.en || 0) + cost);
      event.result = "invalid";
    } else {
      player.activeDefense = activeDefense;
      event.result = "defense";
      event.effects.push({
        kind: "defense",
        actorTeam: player.team,
        username: player.username,
        team: player.team,
        coord: cloneCoord(player.combat.coord),
        cardAnimation: card?.animation || activeDefense.mode || "",
        cardVoice: card?.voice || "",
        unitIcon: (findUnitData(player.selectedUnitId) || {}).icon || (findUnitData(player.selectedUnitId) || {}).appearance || "",
      });
      logs.push(`${player.nickname} 激活防御牌“${card?.name || entry.id}”。`);
    }
  }
  const succeeded = cardUseSucceeded(entry, event);
  if (!succeeded) {
    player.combat.en = Math.min(player.combat.maxEN || 0, Number(player.combat.en || 0) + cost);
  } else {
    recordSuccessfulCardUse(room, player, entry, logs, event);
  }
  const cd = cardCooldown(entry);
  if (succeeded && cd > 0) player.cooldowns[cardCooldownKey(entry)] = Math.max(Number(player.cooldowns[cardCooldownKey(entry)] || 0), cd);
  addResolutionEvent(room, event);
}

function evaluateDuelVictory(room, logs) {
  const missionType = String(loadMapDefinition(room.mapId)?.mission?.type || "").toLowerCase();
  if (missionType !== "duel") return false;
  const teams = ["Team I", "Team II"];
  const aliveByTeam = Object.fromEntries(
    teams.map((team) => [
      team,
      battleParticipants(room).some((player) => player.team === team && player.combat?.alive !== false),
    ])
  );
  if (aliveByTeam["Team I"] && aliveByTeam["Team II"]) return false;
  if (!aliveByTeam["Team I"] && !aliveByTeam["Team II"]) {
    room.battle.winner = "平局";
    logs.push("双方机甲同回合被击坠，本局判定为平局。");
  } else {
    room.battle.winner = aliveByTeam["Team I"] ? "Team I" : "Team II";
    logs.push(`${room.battle.winner} 击坠对方机甲，获得胜利。`);
  }
  return true;
}

function applyFeatureHpEnLoss(room, sourcePlayer, targetPlayer, feature, hpLoss, enLoss, logs, event) {
  if (!targetPlayer?.combat?.alive) return;
  const hpBefore = Number(targetPlayer.combat.hp || 0);
  const enBefore = Number(targetPlayer.combat.en || 0);
  const actualHpLoss = Math.max(0, Number(hpLoss || 0));
  const actualEnLoss = Math.max(0, Number(enLoss || 0));
  if (actualEnLoss > 0) targetPlayer.combat.en = Math.max(0, enBefore - actualEnLoss);
  if (actualHpLoss > 0 && hpBefore > 0) {
    targetPlayer.combat.hp = Math.max(1, hpBefore - actualHpLoss);
    recordDamageContribution(targetPlayer, sourcePlayer);
    if (Number(targetPlayer.combat.hp || 0) <= 1 && !targetPlayer.combat.pendingKO) {
      const effects = ensureCombatEffects(targetPlayer);
      if (Number(effects.guts || 0) > 0) {
        effects.guts = 0;
        targetPlayer.combat.hp = Math.max(10, Number(targetPlayer.combat.hp || 0));
        logs.push(`${targetPlayer.nickname} 的精神“底力”生效，HP 固定为 10，本回合不会被击坠。`);
      } else {
        targetPlayer.combat.pendingKO = true;
        awardDefeatStats(room, sourcePlayer, targetPlayer);
        logs.push(`${targetPlayer.nickname} 受到“${feature.name || feature.feature_ID}”影响，即将被击坠。`);
      }
    }
  }
  if (event) {
    event.effects.push({
      kind: "damage",
      targetKind: "player",
      username: targetPlayer.username,
      nickname: targetPlayer.nickname,
      team: targetPlayer.team,
      coord: cloneCoord(targetPlayer.combat.coord),
      damage: actualHpLoss,
      hpBefore,
      hpAfter: Number(targetPlayer.combat.hp || 0),
      enBefore,
      enAfter: Number(targetPlayer.combat.en || 0),
      pendingKO: Boolean(targetPlayer.combat.pendingKO),
      text: feature.name || "FEATURE",
    });
  }
  logs.push(
    `${sourcePlayer.nickname} 的机甲特性“${feature.name || feature.feature_ID}”影响 ${targetPlayer.nickname}：HP -${actualHpLoss}，EN -${actualEnLoss}。`
  );
}

function applyEndOfRoundUnitFeatures(room, logs) {
  for (const sourcePlayer of battleParticipants(room)) {
    if (!sourcePlayer.combat?.alive || !hasUnitFeature(sourcePlayer, "021")) continue;
    const feature = findUnitFeatureData("021") || { feature_ID: "021", name: "地狱气息" };
    const targets = battleParticipants(room).filter(
      (targetPlayer) =>
        targetPlayer.username !== sourcePlayer.username &&
        targetPlayer.team !== sourcePlayer.team &&
        targetPlayer.combat?.alive &&
        Array.isArray(targetPlayer.combat?.coord) &&
        axialDistance(sourcePlayer.combat.coord, targetPlayer.combat.coord) <= 1
    );
    if (!targets.length) continue;
    const event = {
      id: `event_${room.battle.round}_${++room.battle.resolutionSeq}`,
      type: "feature",
      turn: 3,
      actorTeam: sourcePlayer.team,
      actorCoord: cloneCoord(sourcePlayer.combat.coord),
      targetCoord: cloneCoord(sourcePlayer.combat.coord),
      publicAction: publicActionData(sourcePlayer, null, 2, {
        cardType: "feature",
        cardName: feature.name || feature.feature_ID || "机甲特性",
      }),
      effects: [],
      result: "feature",
      visionByTeam: room.simulationFast ? null : visionByTeamSnapshot(room),
    };
    for (const targetPlayer of targets) {
      applyFeatureHpEnLoss(room, sourcePlayer, targetPlayer, feature, 200, 10, logs, event);
    }
    addResolutionEvent(room, event);
  }
}

function applyFlameTileDamage(room, player, damage, logs, event) {
  if (!player?.combat?.alive || !Array.isArray(player.combat.coord)) return;
  const hpBefore = Number(player.combat.hp || 1);
  if (hpBefore <= 1) return;
  const finalDamage = Math.max(0, Number(damage || 0));
  if (finalDamage <= 0) return;
  player.combat.hp = Math.max(1, hpBefore - finalDamage);
  if (Number(player.combat.hp || 0) <= 1 && !player.combat.pendingKO) {
    const effects = ensureCombatEffects(player);
    if (Number(effects.guts || 0) > 0) {
      effects.guts = 0;
      player.combat.hp = Math.max(10, Number(player.combat.hp || 0));
      logs.push(`${player.nickname} 的精神“底力”生效，HP 固定为 10，本回合不会被击坠。`);
    } else {
      player.combat.pendingKO = true;
      awardDefeatStats(room, null, player);
      logs.push(`${player.nickname} 被烈焰格子灼烧，即将被击坠。`);
    }
  }
  event.effects.push({
    kind: "flame",
    targetKind: "player",
    username: player.username,
    nickname: player.nickname,
    team: player.team,
    coord: cloneCoord(player.combat.coord),
    damage: finalDamage,
    hpBefore,
    hpAfter: Number(player.combat.hp || 0),
    pendingKO: Boolean(player.combat.pendingKO),
  });
  logs.push(`${player.nickname} 站在烈焰格子上，HP -${finalDamage}。`);
}

function applyFlameTileHazards(room, logs, turn) {
  const runtime = getMapRuntime(room);
  const rule = flameRuleForMap(runtime.map);
  if (!rule || rule.damage <= 0) return;
  const flameSet = flameCoordSetForRound(room, room.battle?.round || 1);
  if (!flameSet.size) return;
  const targets = battleParticipants(room).filter(
    (player) => player.combat?.alive && Array.isArray(player.combat.coord) && flameSet.has(coordKey(player.combat.coord))
  );
  if (!targets.length) return;
  const firstCoord = cloneCoord(targets[0].combat.coord);
  const event = {
    id: `event_${room.battle.round}_${++room.battle.resolutionSeq}`,
    type: "hazard",
    turn: Number(turn || 0) + 1,
    actorTeam: "",
    actorCoord: null,
    targetCoord: firstCoord,
    publicAction: {
      turn: Number(turn || 0) + 1,
      username: "",
      nickname: rule.name,
      team: "",
      cardType: "system",
      cardName: rule.name,
    },
    effects: [],
    result: "hazard",
    visionByTeam: room.simulationFast ? null : visionByTeamSnapshot(room),
  };
  for (const player of targets) applyFlameTileDamage(room, player, rule.damage, logs, event);
  if (event.effects.length) addResolutionEvent(room, event);
}

function executeSpiritAction(room, player, spiritId, targetUsername, logs, phaseName) {
  if (!player?.combat?.alive || !spiritId) return;
  const spirit = findSpiritData(spiritId);
  const cost = Number(spirit?.SP_cost || 0);
  if (Number(player.combat.sp || 0) < cost) {
    logs.push(`${player.nickname} SP 不足，${phaseName}精神 ${spirit?.name || spiritId} 未发动。`);
    return;
  }
  player.combat.sp = Math.max(0, Number(player.combat.sp || 0) - cost);
  const action = { spiritTargetUsername: targetUsername || "" };
  const event = makeResolutionEvent(room, "spirit", player, null, action, 0, {
    publicAction: {
      cardName: spirit?.name || spiritId,
      cardType: "spirit",
      spiritId,
      spiritName: spirit?.name || spiritId,
    },
    result: "spirit",
  });
  const applied = applySpirit(room, player, spirit, action, logs, event);
  if (!applied) player.combat.sp = Math.min(player.combat.maxSP || 999, Number(player.combat.sp || 0) + cost);
  addResolutionEvent(room, event);
}

function resolveBattleRound(room) {
  room._visionCache = {};
  const logs = [];
  const order = room.battle.actionOrder || Array.from(room.players.keys());
  room.battle.resolutionEvents = [];
  room.battle.resolutionSeq = 0;
  for (const player of battleParticipants(room)) {
    player.activeDefense = null;
    ensureBattleStats(player);
    if (player.combat) {
      clearCombatEffects(player);
      player.combat.damageSources = {};
      player.combat.defeatCredited = false;
      ensureCombatStatus(player).usedCardTypes = {};
    }
    for (const [key, value] of Object.entries(player.cooldowns || {})) {
      if (value > 0) player.cooldowns[key] = Math.max(0, Number(value) - 1);
    }
  }
  logs.push(`第 ${room.battle.round} 回合结算。`);
  applyFlameTileHazards(room, logs, 0);
  for (const username of order) {
    const player = findBattleParticipant(room, username);
    const action = player?.actions?.[0] || {};
    executeSpiritAction(room, player, action.preSpiritId, action.preSpiritTargetUsername, logs, "前置");
  }
  const phases = [
    (entry) => entry?.type === "defense",
    (entry) => entry?.type === "attack" && findCardData("attack", entry.id)?.["M/R"] === "melee",
    (entry) => entry?.type === "utility",
    (entry) => entry?.type === "attack" && findCardData("attack", entry.id)?.["M/R"] !== "melee",
  ];
  for (const phaseFilter of phases) {
    for (const username of order) {
      const player = findBattleParticipant(room, username);
      for (const action of player?.actions || []) {
        const entry = action?.cardKey ? findHandEntry(player, action.cardKey) : null;
        if (!entry || !phaseFilter(entry)) continue;
        executeCard(room, player, entry, action, logs, Number(action.turn || 0));
      }
    }
  }
  for (const username of order) {
    const player = findBattleParticipant(room, username);
    const action = player?.actions?.[0] || {};
    executeSpiritAction(room, player, action.postSpiritId, action.postSpiritTargetUsername, logs, "后置");
  }
  const map = loadMapDefinition(room.mapId);
  for (const player of battleParticipants(room)) {
    player.hand = finalDeckForPlayer(player);
    player.reserveKeys = [];
    player.reservedCards = [];
    player.discardPile = [];
    player.actionConfirmed = false;
    player.nextRoundConfirmed = false;
    player.actions = [emptyBattleAction(0)];
    if (player.combat.alive !== false) {
      player.combat.sp = Math.min(player.combat.maxSP || 999, Number(player.combat.sp || 0) + 5);
      player.combat.en = Number(player.combat.maxEN || 0);
      advanceCardStressForNextRound(player);
    } else {
      player.combat.respawnIn = Math.max(0, Number(player.combat.respawnIn || 0) - 1);
    }
  }
  applyEndOfRoundUnitFeatures(room, logs);
  for (const player of battleParticipants(room)) {
    if (player.combat.pendingKO) {
      player.combat.alive = false;
      player.combat.pendingKO = false;
      player.combat.respawnIn = Number(map?.respawn_rounds?.[player.team] || 3);
      player.combat.hp = 0;
      player.combat.en = 0;
      player.combat.sp = 0;
      addResolutionEvent(room, {
        id: `event_${room.battle.round}_${++room.battle.resolutionSeq}`,
        type: "destroyed",
        turn: 3,
        actorTeam: player.team,
        actorCoord: cloneCoord(player.combat.coord),
        targetCoord: cloneCoord(player.combat.coord),
        publicAction: publicActionData(player, null, 2, {
          cardType: "system",
          cardName: "击坠",
        }),
        effects: [
          {
            kind: "destroyed",
            targetKind: "player",
            username: player.username,
            nickname: player.nickname,
            team: player.team,
            coord: cloneCoord(player.combat.coord),
          },
        ],
        result: "destroyed",
      });
      logs.push(`${player.nickname} 被击坠，进入待复活状态。`);
    }
  }
  evaluateDuelVictory(room, logs);
  room.battle.stage = "resolved";
  for (const player of roomPlayers(room)) {
    player.actionConfirmed = false;
    player.nextRoundConfirmed = false;
  }
  room.battle.logs = [...logs, ...(room.battle.logs || [])].slice(0, 120);
}

function enemyTeamOf(team) {
  return team === "Team I" ? "Team II" : "Team I";
}

function aiFallbackTarget(room, player) {
  const enemyTeam = enemyTeamOf(player.team);
  const enemyBase = room.bases?.[enemyTeam];
  if (Array.isArray(enemyBase?.coord)) return cloneCoord(enemyBase.coord);
  const enemy = battleParticipants(room).find((item) => item.team !== player.team && item.combat?.alive !== false && Array.isArray(item.combat?.coord));
  if (enemy) return cloneCoord(enemy.combat.coord);
  return cloneCoord(player.combat?.coord);
}

function visibleEnemyPlayers(room, player) {
  return battleParticipants(room)
    .filter(
      (other) =>
        other.team !== player.team &&
        other.combat?.alive !== false &&
        Array.isArray(other.combat?.coord) &&
        isCoordVisibleToTeam(room, player.team, other.combat.coord)
    )
    .sort((a, b) => {
      const hpA = Number(a.combat?.hp ?? 999999);
      const hpB = Number(b.combat?.hp ?? 999999);
      if (hpA !== hpB) return hpA - hpB;
      return axialDistance(player.combat?.coord, a.combat?.coord) - axialDistance(player.combat?.coord, b.combat?.coord);
    });
}

function aiCardAvailable(player, entry, usedKeys, usedCooldownKeys, remainingEn) {
  if (!entry || usedKeys.has(entry.key)) return false;
  if (Number(player.cooldowns?.[cardCooldownKey(entry)] || 0) > 0) return false;
  if (cardCooldown(entry) > 0 && usedCooldownKeys.has(cardCooldownKey(entry))) return false;
  return cardCostForPlayer(player, entry) <= remainingEn;
}

function aiCommitCard(player, entry, usedKeys, usedCooldownKeys) {
  usedKeys.add(entry.key);
  if (cardCooldown(entry) > 0) usedCooldownKeys.add(cardCooldownKey(entry));
}

function aiAttackScore(room, player, entry, from, targetCoord, targetPlayer) {
  const card = findCardData("attack", entry.id);
  if (!card || !Array.isArray(from) || !Array.isArray(targetCoord)) return -Infinity;
  const range = axialDistance(from, targetCoord);
  if (range < Number(card.min_range || 0) || range > Number(card.max_range || 0)) return -Infinity;
  const radius = Math.max(0, Number(card.AOE_radius || 0));
  const possibleTargets = collectTargetsAt(room, targetCoord, radius).filter(
    (target) => !(target.kind === "player" && target.player.username === player.username)
  );
  const enemyHits = possibleTargets.filter((target) => target.kind === "player" && target.player.team !== player.team);
  const allyHits = possibleTargets.filter((target) => target.kind === "player" && target.player.team === player.team);
  const baseHit = possibleTargets.some((target) => target.kind === "base" && target.base.team !== player.team);
  const armor = targetPlayer ? unitArmorAt(room, targetPlayer) : 0;
  const ratio = damageRatioForAttack(card, targetPlayer ? axialDistance(targetPlayer.combat.coord, targetCoord) : 0, player);
  const estimatedDamage = Math.floor(Math.max(10, (cardDamageValue(card) - armor) * ratio));
  const killBonus = targetPlayer && estimatedDamage >= Number(targetPlayer.combat?.hp || 0) ? 3500 : 0;
  return estimatedDamage + killBonus + enemyHits.length * 900 + (baseHit ? 450 : 0) - allyHits.length * 600 - cardCostForPlayer(player, entry) * 2;
}

function aiChooseAttack(room, player, coord, usedKeys, usedCooldownKeys, remainingEn) {
  const enemies = visibleEnemyPlayers(room, player);
  if (!enemies.length) return null;
  let best = null;
  for (const entry of player.hand || []) {
    if (entry.type !== "attack" || !aiCardAvailable(player, entry, usedKeys, usedCooldownKeys, remainingEn)) continue;
    for (const enemy of enemies) {
      const candidates = [cloneCoord(enemy.combat.coord)];
      for (const direction of AXIAL_DIRECTIONS) {
        candidates.push(addCoord(enemy.combat.coord, direction));
      }
      for (const target of candidates) {
        const score = aiAttackScore(room, player, entry, coord, target, enemy);
        if (!best || score > best.score) best = { entry, target, score };
      }
    }
  }
  return best && best.score > -Infinity ? best : null;
}

function aiUtilityDestination(room, player, coord, entry, target) {
  const card = findCardData("utility", entry.id);
  const movementKind = utilityMovementKind(card);
  if (!movementKind) return null;
  const limit = movementLimitForPlayer(room, player, card, movementKind);
  if (movementKind === "charge") return resolveChargeMove(room, player, coord, target, limit).destination;
  if (movementKind === "move") return nearestReachableMovementPath(room, coord, target, limit, player)?.coord || null;
  if (movementKind === "teleport") return nearestTeleportDestination(room, coord, target, limit, player);
  return null;
}

function aiChooseUtility(room, player, coord, usedKeys, usedCooldownKeys, remainingEn) {
  const visible = visibleEnemyPlayers(room, player);
  const target = visible[0]?.combat?.coord || aiFallbackTarget(room, player);
  let best = null;
  for (const entry of player.hand || []) {
    if (entry.type !== "utility" || !aiCardAvailable(player, entry, usedKeys, usedCooldownKeys, remainingEn)) continue;
    const card = findCardData("utility", entry.id);
    if (!utilityMovementKind(card)) continue;
    const destination = aiUtilityDestination(room, player, coord, entry, target);
    if (!destination || coordKey(destination) === coordKey(coord)) continue;
    const before = axialDistance(coord, target);
    const after = axialDistance(destination, target);
    const aggressionBonus = visible.length ? 200 : 0;
    const score = (before - after) * 1000 + aggressionBonus - cardCostForPlayer(player, entry);
    if (!best || score > best.score) best = { entry, target: cloneCoord(target), destination: cloneCoord(destination), score };
  }
  return best && best.score > 0 ? best : null;
}

function aiChooseDefense(player, usedKeys, usedCooldownKeys, remainingEn) {
  const hpRatio = Number(player.combat?.hp || 0) / Math.max(1, Number(player.combat?.maxHP || 1));
  if (hpRatio > 0.45) return null;
  return (player.hand || [])
    .filter((entry) => entry.type === "defense" && aiCardAvailable(player, entry, usedKeys, usedCooldownKeys, remainingEn))
    .sort((a, b) => cardCostForPlayer(player, a) - cardCostForPlayer(player, b))[0] || null;
}

function generateBattleFanaticPlan(room, player) {
  const actions = [0, 1, 2].map((turn) => ({
    turn,
    spiritId: "",
    spiritTargetUsername: "",
    cardKey: "",
    target: null,
    targetPath: [],
  }));
  if (!player.combat?.alive) return { actions, reserveKeys: [] };
  const usedKeys = new Set();
  const usedCooldownKeys = new Set();
  let remainingEn = Number(player.combat?.en || 0);
  let planningCoord = cloneCoord(player.combat?.coord);
  for (let turn = 0; turn < actions.length; turn += 1) {
    const attack = aiChooseAttack(room, player, planningCoord, usedKeys, usedCooldownKeys, remainingEn);
    if (attack) {
      aiCommitCard(player, attack.entry, usedKeys, usedCooldownKeys);
      remainingEn -= cardCostForPlayer(player, attack.entry);
      actions[turn] = { ...actions[turn], cardKey: attack.entry.key, target: cloneCoord(attack.target) };
      continue;
    }
    const utility = aiChooseUtility(room, player, planningCoord, usedKeys, usedCooldownKeys, remainingEn);
    if (utility) {
      aiCommitCard(player, utility.entry, usedKeys, usedCooldownKeys);
      remainingEn -= cardCostForPlayer(player, utility.entry);
      planningCoord = cloneCoord(utility.destination) || planningCoord;
      actions[turn] = { ...actions[turn], cardKey: utility.entry.key, target: cloneCoord(utility.target) };
      continue;
    }
    const defense = aiChooseDefense(player, usedKeys, usedCooldownKeys, remainingEn);
    if (defense) {
      aiCommitCard(player, defense, usedKeys, usedCooldownKeys);
      remainingEn -= cardCostForPlayer(player, defense);
      actions[turn] = { ...actions[turn], cardKey: defense.key, target: cloneCoord(planningCoord) };
    }
  }
  return { actions, reserveKeys: [] };
}

function runAiPlanningIfNeeded(room) {
  if (room.mode !== "ai_sim" || room.phase !== "battle" || room.battle?.stage !== "planning") return;
  room._visionCache = {};
  for (const player of battleParticipants(room)) {
    if (!isAiPlayer(player) || player.combat?.alive === false || player.actionConfirmed) continue;
    try {
      const draft = generateBattleFanaticPlan(room, player);
      const plan = validateBattlePlan(player, draft.actions, draft.reserveKeys);
      player.actions = plan.actions;
      player.reserveKeys = plan.reserveKeys;
      player.actionConfirmed = true;
    } catch (error) {
      player.actions = [0, 1, 2].map((turn) => ({ turn, spiritId: "", spiritTargetUsername: "", cardKey: "", target: null, targetPath: [] }));
      player.reserveKeys = [];
      player.actionConfirmed = true;
      room.battle.logs.unshift(`${player.nickname} AI 行动生成失败，跳过本回合：${error.message || "未知错误"}`);
    }
  }
  const participants = battleParticipants(room);
  if (!participants.length || participants.every((player) => player.combat?.alive === false || player.actionConfirmed)) {
    resolveBattleRound(room);
  }
}

function createAiPlayer(config, team, index) {
  const pilotId = String(config?.pilotId || DEFAULT_AI_PILOT_ID).trim();
  const unitId = String(config?.unitId || "").trim();
  if (!findPilotData(pilotId) || !findUnitData(unitId)) {
    const error = new Error("AI 驾驶员或机甲配置无效。");
    error.status = 400;
    throw error;
  }
  return {
    username: `ai_${team === "Team I" ? "i" : "ii"}_${index}_${makeId("bot", 3)}`,
    nickname: `${team === "Team I" ? "I" : "II"}-${index + 1} 战斗狂热者`,
    avatar: "",
    team,
    ready: true,
    isAI: true,
    aiType: "battle_fanatic",
    selectedPilotId: pilotId,
    selectedUnitId: unitId,
    pilotConfirmed: true,
    unitConfirmed: true,
    deckRemovals: validateDeckRemovals(unitId, normalizeAiRemovalKeys(config?.removalKeys)),
    loadoutConfirmed: true,
    revealConfirmed: true,
    stats: { kills: 0, deaths: 0, assists: 0 },
  };
}

function normalizeAiRemovalKeys(value) {
  if (Array.isArray(value)) return value;
  return String(value || "")
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createAiSimulationRoom(user, body, options = {}) {
  const room = {
    id: makeId("sim", 3).toUpperCase(),
    name: String(body.name || "AI模拟测试").trim().slice(0, 32),
    hostUsername: user.username,
    mode: "ai_sim",
    status: "started",
    createdAt: Date.now(),
    startedAt: Date.now(),
    phase: "battle",
    mapId: String(body.mapId || DEFAULT_AI_MAP_ID).padStart(3, "0"),
    rules: normalizeRules(body.rules || DEFAULT_RULES),
    players: new Map(),
    simulationFast: Boolean(options.fast),
  };
  if (options.observer !== false) {
    room.players.set(user.username, {
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar || "",
      observer: true,
      team: "",
      ready: true,
      stats: { kills: 0, deaths: 0, assists: 0 },
    });
  }
  const teamI = Array.isArray(body.teamI) ? body.teamI.slice(0, 6) : [];
  const teamII = Array.isArray(body.teamII) ? body.teamII.slice(0, 6) : [];
  if (!teamI.length || !teamII.length) {
    const error = new Error("AI模拟测试需要两队都至少有 1 名 AI。");
    error.status = 400;
    throw error;
  }
  teamI.forEach((config, index) => {
    const player = createAiPlayer(config, "Team I", index);
    room.players.set(player.username, player);
  });
  teamII.forEach((config, index) => {
    const player = createAiPlayer(config, "Team II", index);
    room.players.set(player.username, player);
  });
  initializeBattle(room);
  runAiPlanningIfNeeded(room);
  return room;
}

function clampInteger(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function summarizeAiPlayer(player, slot) {
  const pilot = findPilotData(player.selectedPilotId) || {};
  const unit = findUnitData(player.selectedUnitId) || {};
  return {
    slot,
    team: player.team,
    pilotId: player.selectedPilotId,
    pilotName: pilot.pilot_name || pilot.name || player.selectedPilotId,
    unitId: player.selectedUnitId,
    unitName: unit.unit_name || unit.name || player.selectedUnitId,
    kills: Number(player.stats?.kills || 0),
    deaths: Number(player.stats?.deaths || 0),
    assists: Number(player.stats?.assists || 0),
  };
}

function simulateOneAiBattle(user, body, index, maxRounds) {
  const room = createAiSimulationRoom(user, { ...body, name: `AI模拟测试 ${index + 1}` }, { fast: true, observer: false });
  room.battle.resolutionEvents = [];
  room.battle.logs = [];
  while (room.phase !== "ended" && Number(room.battle?.round || 1) < maxRounds) {
    startNextBattleRound(room);
    runAiPlanningIfNeeded(room);
    if (room.battle) {
      room.battle.resolutionEvents = [];
      room.battle.logs = [];
    }
  }
  const participants = battleParticipants(room);
  const teamIBase = room.bases?.["Team I"];
  const teamIIBase = room.bases?.["Team II"];
  return {
    winner: room.battle?.winner || "",
    rounds: Number(room.battle?.round || 1),
    reachedRoundLimit: room.phase !== "ended",
    teamIBaseHp: Math.max(0, Number(teamIBase?.hp || 0)),
    teamIIBaseHp: Math.max(0, Number(teamIIBase?.hp || 0)),
    players: participants.map((player, slot) => summarizeAiPlayer(player, slot)),
  };
}

function runAiSimulationBatch(user, body) {
  const repeatCount = clampInteger(body.repeatCount, 1, 1, 5000);
  const maxRounds = clampInteger(body.maxRounds, 80, 1, 300);
  const summary = {
    repeatCount,
    maxRounds,
    teamIWins: 0,
    teamIIWins: 0,
    draws: 0,
    averageRounds: 0,
    roundLimitGames: 0,
    averageTeamIBaseHp: 0,
    averageTeamIIBaseHp: 0,
    playerAverages: [],
  };
  const playerTotals = new Map();
  for (let i = 0; i < repeatCount; i += 1) {
    const result = simulateOneAiBattle(user, body, i, maxRounds);
    if (result.winner === "Team I") summary.teamIWins += 1;
    else if (result.winner === "Team II") summary.teamIIWins += 1;
    else summary.draws += 1;
    if (result.reachedRoundLimit) summary.roundLimitGames += 1;
    summary.averageRounds += result.rounds;
    summary.averageTeamIBaseHp += result.teamIBaseHp;
    summary.averageTeamIIBaseHp += result.teamIIBaseHp;
    for (const player of result.players) {
      const key = `${player.team}:${player.slot}`;
      const total = playerTotals.get(key) || { ...player, games: 0, kills: 0, deaths: 0, assists: 0 };
      total.games += 1;
      total.kills += player.kills;
      total.deaths += player.deaths;
      total.assists += player.assists;
      playerTotals.set(key, total);
    }
  }
  summary.averageRounds = Number((summary.averageRounds / repeatCount).toFixed(2));
  summary.averageTeamIBaseHp = Number((summary.averageTeamIBaseHp / repeatCount).toFixed(1));
  summary.averageTeamIIBaseHp = Number((summary.averageTeamIIBaseHp / repeatCount).toFixed(1));
  summary.teamIWinRate = Number(((summary.teamIWins / repeatCount) * 100).toFixed(2));
  summary.teamIIWinRate = Number(((summary.teamIIWins / repeatCount) * 100).toFixed(2));
  summary.drawRate = Number(((summary.draws / repeatCount) * 100).toFixed(2));
  summary.playerAverages = Array.from(playerTotals.values()).map((player) => ({
    team: player.team,
    slot: player.slot,
    pilotName: player.pilotName,
    unitName: player.unitName,
    averageKills: Number((player.kills / player.games).toFixed(2)),
    averageDeaths: Number((player.deaths / player.games).toFixed(2)),
    averageAssists: Number((player.assists / player.games).toFixed(2)),
  }));
  return summary;
}

function serializeRoom(room) {
  const { _mapRuntime, _visionCache, ...serializableRoom } = room;
  return {
    ...serializableRoom,
    players: Array.from(room.players.values()),
  };
}

function hydrateRoom(rawRoom) {
  return {
    id: rawRoom.id,
    name: rawRoom.name,
    hostUsername: rawRoom.hostUsername,
    mode: rawRoom.mode || "standard",
    status: rawRoom.status || "waiting",
    createdAt: rawRoom.createdAt || Date.now(),
    startedAt: rawRoom.startedAt || null,
    phase: BATTLE_PHASES.has(rawRoom.phase) ? rawRoom.phase : rawRoom.status === "started" ? "pilot" : "lobby",
    mapId: String(rawRoom.mapId || DEFAULT_MAP_ID),
    rules: normalizeRules(rawRoom.rules),
    players: new Map((rawRoom.players || []).map((player) => [player.username, player])),
    combatants: Array.isArray(rawRoom.combatants) ? rawRoom.combatants : [],
    battle: rawRoom.battle || null,
    bases: rawRoom.bases || {},
    mapTreasures: rawRoom.mapTreasures || [],
  };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    for (const user of raw.users || []) {
      if (user.username) users.set(user.username, user);
    }
    for (const session of raw.sessions || []) {
      if (session.sessionId && users.has(session.username)) {
        sessions.set(session.sessionId, session.username);
      }
    }
    for (const rawRoom of raw.rooms || []) {
      if (rawRoom.id) rooms.set(rawRoom.id, hydrateRoom(rawRoom));
    }
  } catch (error) {
    console.warn(`Unable to load saved state from ${STATE_FILE}: ${error.message}`);
  }
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const nextState = {
    version: 2,
    updatedAt: new Date().toISOString(),
    users: Array.from(users.values()),
    sessions: Array.from(sessions.entries()).map(([sessionId, username]) => ({ sessionId, username })),
    rooms: Array.from(rooms.values()).map(serializeRoom),
  };
  const tempFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(nextState, null, 2), "utf8");
  fs.renameSync(tempFile, STATE_FILE);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function text(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4_000_000) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求格式不是有效 JSON"));
      }
    });
  });
}

function getSessionUser(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) return null;
  return users.get(sessions.get(sessionId)) || null;
}

function publicUser(user) {
  return {
    username: user.username,
    nickname: user.nickname,
    avatar: user.avatar || "",
  };
}

function publicBattlePlayer(player, viewerPlayer, room) {
  const isGodView = isObserverPlayer(viewerPlayer) && room.mode === "ai_sim";
  const sameTeam = viewerPlayer && player.team === viewerPlayer.team;
  const ownerUsername = player.ownerUsername || player.username;
  const isSelf = viewerPlayer && (player.username === viewerPlayer.username || ownerUsername === viewerPlayer.username);
  const enemyVisible =
    viewerPlayer &&
    player.team !== viewerPlayer.team &&
    player.combat?.coord &&
    isCoordVisibleToTeam(room, viewerPlayer.team, player.combat.coord);
  const showPlans = isGodView || isSelf || sameTeam || room.battle?.stage !== "planning";
  const publicActions = showPlans
    ? isGodView || isSelf || sameTeam
      ? player.actions || []
        : (player.actions || []).map((action) => ({
          turn: action.turn,
          preSpiritId: action.preSpiritId || "",
          preSpiritTargetUsername: action.preSpiritTargetUsername || "",
          postSpiritId: action.postSpiritId || "",
          postSpiritTargetUsername: action.postSpiritTargetUsername || "",
          cardKey: action.cardKey || "",
          target: null,
          targetPath: [],
        }))
    : [];
  const publicCombat = player.combat
    ? isGodView || isSelf || sameTeam || enemyVisible
      ? {
          ...player.combat,
          effectiveArmor: room.phase === "battle" || room.phase === "ended" ? unitArmorAt(room, player) : player.combat.armor,
        }
      : {
          alive: player.combat.alive,
          coord: null,
          hp: null,
          maxHP: null,
          en: null,
          maxEN: null,
          sp: null,
          maxSP: null,
          armor: null,
          effectiveArmor: null,
        }
    : null;
  return {
    username: player.username,
    ownerUsername,
    ownerNickname: player.ownerNickname || player.nickname,
    nickname: player.nickname,
    team: player.team,
    combatant: Boolean(player.combatant),
    isAI: Boolean(player.isAI),
    aiType: player.aiType || "",
    observer: Boolean(player.observer),
    selectedPilotId: player.selectedPilotId || "",
    selectedUnitId: player.selectedUnitId || "",
    deckRemovals: Array.isArray(player.deckRemovals) ? player.deckRemovals : [],
    stats: ensureBattleStats(player),
    combat: publicCombat,
    actionConfirmed: Boolean(player.actionConfirmed || room.players.get(ownerUsername)?.actionConfirmed),
    hand: isSelf ? player.hand || [] : [],
    battleDeckCount: isSelf ? (player.battleDeck || []).length : undefined,
    discardCount: isSelf ? (player.discardPile || []).length : undefined,
    reservedCards: isSelf ? player.reservedCards || [] : [],
    reserveKeys: isSelf ? player.reserveKeys || [] : [],
    cooldowns: isSelf ? player.cooldowns || {} : {},
    actions: publicActions,
    nextRoundConfirmed: Boolean(player.nextRoundConfirmed || room.players.get(ownerUsername)?.nextRoundConfirmed),
  };
}

function publicRoom(room, viewer = null) {
  const fullPlayers = Array.from(room.players.values());
  const nonObservers = fullPlayers.filter((player) => !isObserverPlayer(player));
  const participants = battleParticipants(room);
  const mapDefinition =
    room.phase === "battle" || room.phase === "ended" ? loadMapDefinition(room.mapId) || {} : null;
  const treasureChests = mapDefinition?.treasure_chests;
  const teamMaxPlayers = mapTeamMaxPlayers(room.mapId);
  const teamICount = nonObservers.filter((p) => p.team === "Team I").length;
  const teamIICount = nonObservers.filter((p) => p.team === "Team II").length;
  const allReady = nonObservers.length > 0 && nonObservers.every((p) => p.ready);
  const viewerPlayer = viewer ? room.players.get(viewer.username) : null;
  const isPrivatePrepPhase =
    room.status === "started" && ["pilot", "unit", "loadout"].includes(room.phase) && viewerPlayer?.team;
  const visiblePlayers = isPrivatePrepPhase
    ? fullPlayers.filter((player) => player.team === viewerPlayer.team || player.username === viewer.username)
    : fullPlayers;
  const visibleTreasures =
    room.phase === "battle" || room.phase === "ended"
      ? (room.mapTreasures || []).filter((item) => !viewerPlayer?.team || isCoordVisibleToTeam(room, viewerPlayer.team, item.coord))
      : [];
  const flameTiles = mapDefinition ? flameCoordsForRound(room, room.battle?.round || 1) : [];
  const flameSet = new Set(flameTiles.map(coordKey));
  const flameRule = flameRuleForMap(mapDefinition);
  const players = visiblePlayers.map((player) => ({
    username: player.username,
    nickname: player.nickname,
    avatar: player.avatar || "",
    team: player.team,
    ready: player.ready,
    selectedPilotId: player.selectedPilotId || "",
    selectedPilotIds: playerPilotIds(player),
    selectedUnitId: player.selectedUnitId || "",
    selectedUnitIds: playerUnitIds(player),
    pilotConfirmed: Boolean(player.pilotConfirmed),
    unitConfirmed: Boolean(player.unitConfirmed),
    deckRemovals: Array.isArray(player.deckRemovals) ? player.deckRemovals : [],
    deckRemovalsByUnit: Array.isArray(player.deckRemovalsByUnit) ? player.deckRemovalsByUnit : [],
    loadoutConfirmed: Boolean(player.loadoutConfirmed),
    revealConfirmed: Boolean(player.revealConfirmed),
    stats: player.stats || { kills: 0, deaths: 0, assists: 0 },
    isHost: player.username === room.hostUsername,
    isAI: Boolean(player.isAI),
    aiType: player.aiType || "",
    observer: Boolean(player.observer),
  }));
  const battlePlayers =
    room.phase === "battle" || room.phase === "ended"
      ? participants.map((player) => publicBattlePlayer(player, viewerPlayer, room))
      : [];
  return {
    id: room.id,
    name: room.name,
    hostUsername: room.hostUsername,
    mode: room.mode || "standard",
    status: room.status,
    createdAt: room.createdAt,
    startedAt: room.startedAt || null,
    phase: room.status === "started" ? room.phase || "pilot" : "lobby",
    mapId: room.mapId || DEFAULT_MAP_ID,
    rules: normalizeRules(room.rules),
    players,
    playerCount: nonObservers.length,
    bases: room.bases || {},
    mapBounds: room.phase === "battle" || room.phase === "ended" ? getMapBounds(room.mapId) : null,
    mapViewRadius: mapDefinition ? Number(mapDefinition.radius_of_view || 5) : null,
    mapTiles:
      mapDefinition && Array.isArray(mapDefinition.tiles)
        ? mapDefinition.tiles.map((tile) => {
            const isFlame = flameSet.has(coordKey(tile.coord));
            const info = isFlame
              ? { name: flameRule?.name || "烈焰格子", text: flameRule?.text || "站在其上的机甲，每轮结算开始时 HP -400" }
              : tileInGameInfo(tile);
            return {
              coord: tile.coord,
              type: isFlame ? "flame" : tile.type,
              inGameName: info.name,
              inGameText: info.text,
              blocking: Boolean(tile.blocking),
              description: tile.description || "",
              team: tile.team || "",
              armor_bonus: tile.armor_bonus || 0,
            };
          })
        : [],
    flameTiles,
    mapTreasures: visibleTreasures.length ? visibleTreasures : mapDefinition && Array.isArray(treasureChests) ? treasureChests : [],
    battle: room.battle
      ? {
          round: room.battle.round,
          stage: room.battle.stage,
          drawCount: room.battle.drawCount,
          actionOrder: room.battle.actionOrder || [],
          logs: room.battle.logs || [],
          resolutionEvents: resolutionEventsForViewer(room, viewerPlayer),
          winner: room.battle.winner || "",
          players: battlePlayers,
        }
      : null,
    canStart:
      teamICount >= 1 &&
      teamIICount >= 1 &&
      teamICount <= teamMaxPlayers["Team I"] &&
      teamIICount <= teamMaxPlayers["Team II"] &&
      allReady,
    teamICount,
    teamIICount,
    teamMaxPlayers,
  };
}

function requireUser(body) {
  const user = getSessionUser(body.sessionId);
  if (!user) {
    const error = new Error("请先登录");
    error.status = 401;
    throw error;
  }
  return user;
}

function addPlayer(room, user) {
  if (!room.players.has(user.username)) {
    room.players.set(user.username, {
      username: user.username,
      nickname: user.nickname,
      avatar: user.avatar || "",
      team: "",
      ready: false,
      selectedPilotId: "",
      selectedPilotIds: [],
      selectedUnitId: "",
      selectedUnitIds: [],
      pilotConfirmed: false,
      unitConfirmed: false,
      deckRemovals: [],
      deckRemovalsByUnit: [],
      loadoutConfirmed: false,
      revealConfirmed: false,
      stats: { kills: 0, deaths: 0, assists: 0 },
    });
  }
}

function resetReady(room) {
  for (const player of room.players.values()) {
    player.ready = false;
  }
}

function resetBattleSelections(room) {
  room.phase = room.status === "started" ? "pilot" : "lobby";
  room.combatants = [];
  for (const player of room.players.values()) {
    player.selectedPilotId = "";
    player.selectedPilotIds = [];
    player.selectedUnitId = "";
    player.selectedUnitIds = [];
    player.pilotConfirmed = false;
    player.unitConfirmed = false;
    player.deckRemovals = [];
    player.deckRemovalsByUnit = [];
    player.loadoutConfirmed = false;
    player.revealConfirmed = false;
  }
}

function findStaticFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const routes = [
    { prefix: "/assets/icon_images/", dir: path.join(ROOT, "icon_images") },
    { prefix: "/assets/pilot_images/", dir: path.join(ROOT, "pilot_images") },
    { prefix: "/assets/unit_images/", dir: path.join(ROOT, "unit_images") },
    { prefix: "/assets/card_images/", dir: path.join(ROOT, "card_images") },
    { prefix: "/assets/voice/", dir: path.join(ROOT, "voice") },
    { prefix: "/assets/maps/", dir: path.join(PUBLIC_DIR, "assets", "maps") },
    { prefix: "/assets/ui/", dir: path.join(PUBLIC_DIR, "assets", "ui") },
  ];

  for (const route of routes) {
    if (decoded.startsWith(route.prefix)) {
      const rel = decoded.slice(route.prefix.length);
      const full = path.normalize(path.join(route.dir, rel));
      if (full.startsWith(route.dir)) return full;
    }
  }

  const relPath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const full = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (full.startsWith(PUBLIC_DIR)) return full;
  return null;
}

function serveStatic(req, res) {
  const file = findStaticFile(req.url);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    text(res, 404, "Not found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const assetDirs = [path.join(ROOT, "icon_images"), path.join(ROOT, "unit_images")];
  const isReplaceableImageAsset = assetDirs.some((dir) => file.startsWith(dir));
  const isLiveDataAsset = [".html", ".css", ".js", ".json"].includes(ext);
  res.writeHead(200, {
    "content-type": mimeTypes[ext] || "application/octet-stream",
    "cache-control": isLiveDataAsset || isReplaceableImageAsset ? "no-store" : "public, max-age=300",
  });
  fs.createReadStream(file).pipe(res);
}

async function routeApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  if (method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && url.pathname === "/api/rooms") {
    json(res, 200, {
      rooms: Array.from(rooms.values())
        .filter((room) => room.mode !== "ai_sim")
        .map((room) => {
          const summary = publicRoom(room);
          summary.players = summary.players.map((player) => ({
            username: player.username,
            nickname: player.nickname,
            avatar: player.avatar,
            team: player.team,
            ready: player.ready,
            isHost: player.isHost,
          }));
          return summary;
        })
        .sort((a, b) => b.createdAt - a.createdAt),
    });
    return;
  }

  const body = method === "GET" ? {} : await readBody(req);

  if (method === "POST" && url.pathname === "/api/register") {
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const nickname = String(body.nickname || "").trim();
    if (!/^[a-zA-Z0-9_]{3,18}$/.test(username)) {
      json(res, 400, { error: "用户名需要 3-18 位字母、数字或下划线" });
      return;
    }
    if (password.length < 4) {
      json(res, 400, { error: "密码至少 4 位" });
      return;
    }
    if (!nickname) {
      json(res, 400, { error: "请输入游戏昵称" });
      return;
    }
    if (users.has(username)) {
      json(res, 409, { error: "用户名已存在" });
      return;
    }
    const user = {
      username,
      passwordHash: crypto.createHash("sha256").update(password).digest("hex"),
      nickname,
      avatar: String(body.avatar || ""),
      createdAt: Date.now(),
    };
    users.set(username, user);
    const sessionId = makeId("session", 12);
    sessions.set(sessionId, username);
    saveState();
    json(res, 201, { sessionId, user: publicUser(user) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/login") {
    const username = String(body.username || "").trim();
    const passwordHash = crypto.createHash("sha256").update(String(body.password || "")).digest("hex");
    const user = users.get(username);
    if (!user || user.passwordHash !== passwordHash) {
      json(res, 401, { error: "用户名或密码不正确" });
      return;
    }
    const sessionId = makeId("session", 12);
    sessions.set(sessionId, username);
    saveState();
    json(res, 200, { sessionId, user: publicUser(user) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/logout") {
    if (body.sessionId) sessions.delete(body.sessionId);
    saveState();
    json(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/session") {
    const user = getSessionUser(body.sessionId);
    if (!user) {
      json(res, 401, { error: "会话已失效" });
      return;
    }
    json(res, 200, { user: publicUser(user) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/rooms") {
    const user = requireUser(body);
    const room = {
      id: makeId("room", 3).toUpperCase(),
      name: String(body.name || `${user.nickname} 的房间`).trim().slice(0, 32),
      hostUsername: user.username,
      mode: "standard",
      status: "waiting",
      createdAt: Date.now(),
      startedAt: null,
      phase: "lobby",
      mapId: String(body.mapId || DEFAULT_MAP_ID),
      rules: normalizeRules(body.rules),
      players: new Map(),
    };
    addPlayer(room, user);
    rooms.set(room.id, room);
    saveState();
    json(res, 201, { room: publicRoom(room, user) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/ai-simulations") {
    const user = requireUser(body);
    const summary = runAiSimulationBatch(user, body);
    json(res, 200, { summary });
    return;
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/);
  if (roomMatch) {
    const roomId = roomMatch[1].toUpperCase();
    const action = roomMatch[2] || "";
    const room = rooms.get(roomId);
    if (!room) {
      json(res, 404, { error: "房间不存在" });
      return;
    }

    if (method === "GET" && !action) {
      const viewer = getSessionUser(url.searchParams.get("sessionId"));
      if (!viewer || !room.players.has(viewer.username)) {
        json(res, 401, { error: "请先登录并加入房间" });
        return;
      }
      json(res, 200, { room: publicRoom(room, viewer) });
      return;
    }

    const user = requireUser(body);

    if (method === "POST" && action === "join") {
      if (room.status !== "waiting") {
        json(res, 409, { error: "房间已经开始，无法加入" });
        return;
      }
      const roomMaxPlayers = Math.min(12, mapTotalMaxPlayers(room.mapId));
      const currentPlayers = Array.from(room.players.values()).filter((player) => !isObserverPlayer(player)).length;
      if (currentPlayers >= roomMaxPlayers && !room.players.has(user.username)) {
        json(res, 409, { error: `Room is full for this map. Max players: ${roomMaxPlayers}.` });
        return;
      }
      addPlayer(room, user);
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (!room.players.has(user.username)) {
      json(res, 403, { error: "你不在这个房间中" });
      return;
    }

    if (method === "POST" && action === "reset-actions") {
      if (room.status !== "started" || room.phase !== "battle" || room.battle?.stage !== "planning") {
        json(res, 409, { error: "当前不能重新设定行动" });
        return;
      }
      const owned = ownerCombatants(room, user.username);
      if (!owned.some((combatant) => combatant.combat?.alive !== false)) {
        json(res, 409, { error: "待复活状态不能重新设定行动" });
        return;
      }
      for (const combatant of owned) {
        combatant.actions = [emptyBattleAction(0)];
        combatant.reserveKeys = [];
        combatant.actionConfirmed = false;
      }
      const player = room.players.get(user.username);
      player.actionConfirmed = false;
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "settings") {
      if (room.hostUsername !== user.username) {
        json(res, 403, { error: "只有房主可以修改地图和规则" });
        return;
      }
      if (room.status !== "waiting") {
        json(res, 409, { error: "游戏已经开始，无法修改地图和规则" });
        return;
      }
      if (body.mapId !== undefined) {
        const mapId = String(body.mapId || "").trim();
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(mapId)) {
          json(res, 400, { error: "地图 ID 不合法" });
          return;
        }
        room.mapId = mapId;
      }
      if (body.rules !== undefined) {
        room.rules = normalizeRules(body.rules);
      }
      resetReady(room);
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "team") {
      const team = String(body.team || "");
      if (!["Team I", "Team II"].includes(team)) {
        json(res, 400, { error: "请选择 Team I 或 Team II" });
        return;
      }
      const player = room.players.get(user.username);
      const teamMaxPlayers = mapTeamMaxPlayers(room.mapId);
      const currentCount = Array.from(room.players.values()).filter(
        (item) => !isObserverPlayer(item) && item.username !== user.username && item.team === team
      ).length;
      if (player.team !== team && currentCount >= teamMaxPlayers[team]) {
        json(res, 409, { error: `${team} is full on this map. Max players: ${teamMaxPlayers[team]}.` });
        return;
      }
      player.team = team;
      player.ready = false;
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "ready") {
      const player = room.players.get(user.username);
      if (!player.team) {
        json(res, 400, { error: "请先选择阵营" });
        return;
      }
      player.ready = Boolean(body.ready);
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "select-pilot") {
      if (room.status !== "started" || room.phase !== "pilot") {
        json(res, 409, { error: "当前不能选择驾驶员" });
        return;
      }
      const pilotIds = normalizeSelectionIds(body.pilotIds, body.pilotId);
      if (!pilotIds.length || pilotIds.some((pilotId) => !/^[a-zA-Z0-9_-]{1,32}$/.test(pilotId) || !findPilotData(pilotId))) {
        json(res, 400, { error: "驾驶员 ID 不合法" });
        return;
      }
      if (pilotIds.length > MAX_CONTROLLED_UNITS) {
        json(res, 400, { error: `每位玩家最多选择 ${MAX_CONTROLLED_UNITS} 名驾驶员` });
        return;
      }
      const player = room.players.get(user.username);
      if (!player.team) {
        json(res, 400, { error: "请先选择阵营" });
        return;
      }
      if (room.rules?.pilotPickMode === "blind") {
        const selectedSet = new Set(pilotIds);
        const duplicated = Array.from(room.players.values()).some(
          (other) =>
            other.username !== user.username &&
            other.team === player.team &&
            playerPilotIds(other).some((pilotId) => selectedSet.has(pilotId))
        );
        if (duplicated) {
          json(res, 409, { error: "盲选模式下，同队不能重复选择同一名驾驶员" });
          return;
        }
      }
      player.selectedPilotIds = pilotIds;
      player.selectedPilotId = pilotIds[0] || "";
      player.pilotConfirmed = false;
      player.selectedUnitIds = [];
      player.selectedUnitId = "";
      player.unitConfirmed = false;
      player.deckRemovals = [];
      player.deckRemovalsByUnit = [];
      player.loadoutConfirmed = false;
      player.revealConfirmed = false;
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "select-unit") {
      if (room.status !== "started" || room.phase !== "unit") {
        json(res, 409, { error: "当前不能选择机甲" });
        return;
      }
      const player = room.players.get(user.username);
      const unitIds = normalizeSelectionIds(body.unitIds, body.unitId);
      if (unitIds.some((unitId) => !/^[a-zA-Z0-9_-]{1,32}$/.test(unitId))) {
        json(res, 400, { error: "机甲 ID 不合法" });
        return;
      }
      const pilotCount = playerPilotIds(player).length;
      if (unitIds.length > MAX_CONTROLLED_UNITS) {
        json(res, 400, { error: `每位玩家最多控制 ${MAX_CONTROLLED_UNITS} 台机甲` });
        return;
      }
      if (unitIds.length > pilotCount) {
        json(res, 400, { error: "机甲数量不能超过已选择的驾驶员数量" });
        return;
      }
      if (unitIds.some((unitId) => !isPlayableUnitData(findUnitData(unitId)))) {
        json(res, 400, { error: "该机甲尚未制作完成，不能选择" });
        return;
      }
      player.selectedUnitIds = unitIds;
      player.selectedUnitId = unitIds[0] || "";
      player.unitConfirmed = false;
      player.deckRemovals = [];
      player.deckRemovalsByUnit = [];
      player.loadoutConfirmed = false;
      player.revealConfirmed = false;
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "confirm-stage") {
      if (room.status !== "started") {
        json(res, 409, { error: "游戏尚未开始" });
        return;
      }
      const player = room.players.get(user.username);
      if (room.phase === "pilot") {
        if (!playerPilotIds(player).length) {
          json(res, 400, { error: "请先选择驾驶员" });
          return;
        }
        player.pilotConfirmed = true;
        const everyoneConfirmed = roomPlayers(room).every((p) => playerPilotIds(p).length && p.pilotConfirmed);
        if (everyoneConfirmed) {
          room.phase = "unit";
          for (const participant of roomPlayers(room)) {
            participant.selectedUnitIds = [];
            participant.selectedUnitId = "";
            participant.unitConfirmed = false;
            participant.deckRemovals = [];
            participant.deckRemovalsByUnit = [];
            participant.loadoutConfirmed = false;
            participant.revealConfirmed = false;
          }
        }
        saveState();
        json(res, 200, { room: publicRoom(room, user) });
        return;
      }
      if (room.phase === "unit") {
        if (!playerUnitIds(player).length || playerUnitIds(player).length !== playerPilotIds(player).length) {
          json(res, 400, { error: "请先选择机甲" });
          return;
        }
        player.unitConfirmed = true;
        const everyoneConfirmed = roomPlayers(room).every((p) => playerUnitIds(p).length === playerPilotIds(p).length && p.unitConfirmed);
        if (everyoneConfirmed) {
          room.phase = "loadout";
          for (const participant of roomPlayers(room)) {
            participant.deckRemovals = [];
            participant.deckRemovalsByUnit = [];
            participant.loadoutConfirmed = false;
            participant.revealConfirmed = false;
          }
        }
        saveState();
        json(res, 200, { room: publicRoom(room, user) });
        return;
      }
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "confirm-loadout") {
      if (room.status !== "started" || room.phase !== "loadout") {
        json(res, 409, { error: "当前不能确认卡组" });
        return;
      }
      const player = room.players.get(user.username);
      const unitIds = playerUnitIds(player);
      if (!unitIds.length) {
        json(res, 400, { error: "请先选择机甲" });
        return;
      }
      const removalsByUnit = Array.isArray(body.removalsByUnit)
        ? body.removalsByUnit
        : unitIds.map((_, index) => (index === 0 ? body.removalKeys || [] : []));
      player.deckRemovalsByUnit = unitIds.map((unitId, index) => validateDeckRemovals(unitId, removalsByUnit[index] || []));
      player.deckRemovals = player.deckRemovalsByUnit[0] || [];
      player.loadoutConfirmed = true;
      player.revealConfirmed = false;
      const everyoneConfirmed = roomPlayers(room).every(
        (p) => playerUnitIds(p).length && Array.isArray(p.deckRemovalsByUnit) && p.deckRemovalsByUnit.length === playerUnitIds(p).length && p.loadoutConfirmed
      );
      if (everyoneConfirmed) {
        room.phase = "reveal";
        for (const participant of roomPlayers(room)) {
          participant.revealConfirmed = false;
        }
      }
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "ready-battle") {
      if (room.status !== "started" || room.phase !== "reveal") {
        json(res, 409, { error: "当前不能进入正式战斗" });
        return;
      }
      const player = room.players.get(user.username);
      player.revealConfirmed = true;
      const everyoneReady = roomPlayers(room).every((p) => p.revealConfirmed);
      if (everyoneReady) initializeBattle(room);
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "set-actions") {
      if (room.status !== "started" || room.phase !== "battle" || room.battle?.stage !== "planning") {
        json(res, 409, { error: "当前不能设定行动" });
        return;
      }
      const player = room.players.get(user.username);
      const owned = ownerCombatants(room, user.username);
      if (!owned.some((combatant) => combatant.combat?.alive !== false)) {
        json(res, 409, { error: "待复活状态不能设定行动" });
        return;
      }
      const incomingActions = Array.isArray(body.actions) ? body.actions : [];
      const cardActionCount = incomingActions.filter((actionItem) => normalizeCardKey(actionItem?.cardKey)).length;
      if (cardActionCount > owned.length) {
        json(res, 400, { error: `本回合最多可设定 ${owned.length} 张卡牌` });
        return;
      }
      for (const combatant of owned) {
        const combatantActions = incomingActions.filter((actionItem) => {
          const actor = String(actionItem?.actorUsername || actionItem?.username || "").trim();
          return actor ? actor === combatant.username : combatant === owned[0];
        });
        if (combatant.combat?.alive === false) {
          combatant.actions = [emptyBattleAction(0)];
          combatant.actionConfirmed = true;
          continue;
        }
        const plan = validateBattlePlan(combatant, combatantActions, []);
        combatant.actions = plan.actions;
        combatant.reserveKeys = [];
        combatant.actionConfirmed = true;
      }
      player.actionConfirmed = true;
      const everyoneConfirmed = roomPlayers(room).every((p) => ownerCombatants(room, p.username).every((c) => c.combat?.alive === false) || p.actionConfirmed);
      if (everyoneConfirmed) resolveBattleRound(room);
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "next-round") {
      if (room.status !== "started" || room.phase !== "battle" || room.battle?.stage !== "resolved") {
        json(res, 409, { error: "当前不能进入下一回合" });
        return;
      }
      if (room.battle?.winner) {
        json(res, 409, { error: "战斗已经结束" });
        return;
      }
      const player = room.players.get(user.username);
      if (room.mode === "ai_sim" && player?.observer) {
        startNextBattleRound(room);
        runAiPlanningIfNeeded(room);
        saveState();
        json(res, 200, { room: publicRoom(room, user) });
        return;
      }
      player.nextRoundConfirmed = true;
      const everyoneConfirmed = roomPlayers(room).every((p) => p.nextRoundConfirmed);
      if (everyoneConfirmed) {
        startNextBattleRound(room);
        runAiPlanningIfNeeded(room);
      }
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }

    if (method === "POST" && action === "leave") {
      if (room.mode === "ai_sim" && room.players.get(user.username)?.observer) {
        rooms.delete(room.id);
        saveState();
        json(res, 200, { ok: true });
        return;
      }
      room.players.delete(user.username);
      if (room.players.size === 0) {
        rooms.delete(room.id);
      } else if (room.hostUsername === user.username) {
        room.hostUsername = room.players.keys().next().value;
        resetReady(room);
      }
      saveState();
      json(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && action === "start") {
      if (room.hostUsername !== user.username) {
        json(res, 403, { error: "只有房主可以开始游戏" });
        return;
      }
      const state = publicRoom(room);
      if (!state.canStart) {
        json(res, 409, { error: "需要双方阵营都至少 1 人，且所有玩家已准备" });
        return;
      }
      room.status = "started";
      room.startedAt = Date.now();
      resetBattleSelections(room);
      saveState();
      json(res, 200, { room: publicRoom(room, user) });
      return;
    }
  }

  text(res, 404, "Not found");
}

loadState();

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await routeApi(req, res);
    } else {
      serveStatic(req, res);
    }
  } catch (error) {
    json(res, error.status || 500, { error: error.message || "服务器错误" });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Robot Battle server running at http://localhost:${PORT}`);
  });
}

module.exports = { server, PORT };
