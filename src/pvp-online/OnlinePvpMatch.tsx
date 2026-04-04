import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PvpMatchPhase, PvpPlayerState, PvpRoundResult } from '../pvp/pvpTypes';
import { createSeededRNG } from '../pvp/pvpWorld';
import { createPlayerState, updatePlayerState, attemptJump } from '../pvp/pvpGameLogic';
import { drawDivider, drawPlayerHUD, drawPlayerWorld, drawRescueCountdown, type Viewport } from '../pvp/pvpRenderer';
import { initAudio } from '../audio';
import { getSkinDef, preloadSkinImages } from '../skins';
import * as Constants from '../constants';
import turtleRescueImgSrc from '../../turtle.png';
import turtleShellItemImgSrc from '../../turtle-shell-item.png';
import tubeImgSrc from '../../tube.png';
import { missionsAPI, onlinePvpAPI, pvpAPI } from '../api';
import type { OnlineMatch, OnlineRoom } from './onlinePvpTypes';

const FIXED_DT = 1 / 60;
const COUNTDOWN_SECONDS = 3;
const MATCH_POLL_MS = 100;
const SNAPSHOT_PUSH_MS = 100;
const ROUND_RESULT_MS = 2200;
const WINNER_FINISH_WINDOW_TICKS = Math.round(3 / FIXED_DT);

const MATCH_PHASE_ORDER: Record<PvpMatchPhase, number> = {
  LOBBY: 0,
  INSTRUCTIONS: 1,
  COUNTDOWN: 2,
  PLAYING: 3,
  ROUND_RESULT: 4,
  MATCH_RESULT: 5,
};

type InputChannel = {
  held: boolean;
  pendingPress: boolean;
  seq: number;
};

type FinishWindowState = {
  active: boolean;
  survivor: 1 | 2 | null;
  ticksRemaining: number;
};

type RenderSnapshot = {
  tick: number;
  phase: PvpMatchPhase;
  countdownValue: number;
  p1: Omit<PvpPlayerState, 'rng'>;
  p2: Omit<PvpPlayerState, 'rng'>;
  roundResult: PvpRoundResult | null;
};

interface Props {
  roomId: string | null;
  matchId: string | null;
  onBackToLobby: () => void;
  onReturnToRoom: (roomId: string) => void;
}

function roundsNeededForFormat(format: OnlineMatch['config']['format']) {
  return format === 'bo5' ? 3 : format === 'bo3' ? 2 : 1;
}

function maxRoundsForFormat(format: OnlineMatch['config']['format']) {
  return format === 'bo5' ? 5 : format === 'bo3' ? 3 : 1;
}

function getSeriesWinnerSlot(series: NonNullable<OnlineMatch['series']>): 1 | 2 | null {
  if (series.p1Wins > series.p2Wins) return 1;
  if (series.p2Wins > series.p1Wins) return 2;
  return null;
}

function shouldAcceptIncomingMatch(current: OnlineMatch | null, incoming: OnlineMatch): boolean {
  if (!current) return true;

  // Hard guards: never regress data completeness regardless of timestamps.
  const currentRounds = current.series?.roundResults?.length || 0;
  const incomingRounds = incoming.series?.roundResults?.length || 0;
  if (incomingRounds < currentRounds) return false;

  // Never regress from MATCH_RESULT to an earlier phase.
  const currentPhaseRank = MATCH_PHASE_ORDER[(current.phase as PvpMatchPhase) || 'COUNTDOWN'] ?? -1;
  const incomingPhaseRank = MATCH_PHASE_ORDER[(incoming.phase as PvpMatchPhase) || 'COUNTDOWN'] ?? -1;
  if (currentPhaseRank === MATCH_PHASE_ORDER.MATCH_RESULT && incomingPhaseRank < currentPhaseRank) return false;

  // Never clear a decided winnerSlot.
  if (current.winnerSlot != null && incoming.winnerSlot == null) return false;

  // Accept if incoming has more round results.
  if (incomingRounds > currentRounds) return true;

  // Accept new round starting (ROUND_RESULT → COUNTDOWN is legitimate when currentRound advances).
  const currentRound = current.series?.currentRound || 1;
  const incomingRound = incoming.series?.currentRound || 1;
  if (incomingRound > currentRound) return true;

  // Accept if phase advances.
  if (incomingPhaseRank > currentPhaseRank) return true;
  if (incomingPhaseRank < currentPhaseRank) return false;

  // Fall back to timestamp comparison.
  const currentUpdatedAt = current.updatedAt || current.createdAt || 0;
  const incomingUpdatedAt = incoming.updatedAt || incoming.createdAt || 0;
  if (incomingUpdatedAt > currentUpdatedAt) return true;
  if (incomingUpdatedAt < currentUpdatedAt) return false;

  return true;
}

function cloneSerializableState(state: PvpPlayerState): Omit<PvpPlayerState, 'rng'> {
  return {
    ...state,
    player: { ...state.player },
    platforms: state.platforms.map((platform) => ({ ...platform })),
    items: state.items.map((item) => ({ ...item })),
    bubbles: state.bubbles.map((bubble) => ({ ...bubble })),
    bgEntities: state.bgEntities.map((entity) => ({ ...entity })),
    rescue: state.rescue.active ? { ...state.rescue } : { active: false },
    tubeRescue: state.tubeRescue.active ? { ...state.tubeRescue } : { active: false },
    trailParticles: [],
    scorePopups: state.scorePopups.map((popup) => ({ ...popup })),
  };
}

function cloneSnapshotPlayer(state: Omit<PvpPlayerState, 'rng'>): Omit<PvpPlayerState, 'rng'> {
  return {
    ...state,
    player: { ...state.player },
    platforms: state.platforms.map((platform) => ({ ...platform })),
    items: state.items.map((item) => ({ ...item })),
    bubbles: state.bubbles.map((bubble) => ({ ...bubble })),
    bgEntities: state.bgEntities.map((entity) => ({ ...entity })),
    rescue: state.rescue.active ? { ...state.rescue } : { active: false },
    tubeRescue: state.tubeRescue.active ? { ...state.tubeRescue } : { active: false },
    trailParticles: Array.isArray(state.trailParticles) ? [...state.trailParticles] : [],
    scorePopups: state.scorePopups.map((popup) => ({ ...popup })),
  };
}

export const OnlinePvpMatch: React.FC<Props> = ({ roomId, matchId, onBackToLobby, onReturnToRoom }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const hostStateRef = useRef<PvpPlayerState | null>(null);
  const guestStateRef = useRef<PvpPlayerState | null>(null);
  const lastTimeRef = useRef(0);
  const accumulatorRef = useRef(0);
  const tickRef = useRef(0);
  const phaseRef = useRef<PvpMatchPhase>('COUNTDOWN');
  const countdownValueRef = useRef(COUNTDOWN_SECONDS);
  const countdownStartedAtRef = useRef(Date.now());
  const phaseStartedAtRef = useRef(Date.now());
  const latestMatchRef = useRef<OnlineMatch | null>(null);
  const latestRoomRef = useRef<OnlineRoom | null>(null);
  const myUserIdRef = useRef<string | null>(null);
  const localInputRef = useRef<InputChannel>({ held: false, pendingPress: false, seq: 0 });
  const remoteInputRef = useRef<InputChannel>({ held: false, pendingPress: false, seq: -1 });
  const lastGuestInputSeqRef = useRef(-1);
  const snapshotPushAtRef = useRef(0);
  const currentRoundResultRef = useRef<PvpRoundResult | null>(null);
  const currentSeedRef = useRef(1);
  const settledBetRef = useRef(false);
  const sentPvpResultRef = useRef(false);
  const finishWindowRef = useRef<FinishWindowState>({ active: false, survivor: null, ticksRemaining: 0 });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [match, setMatch] = useState<OnlineMatch | null>(null);
  const [room, setRoom] = useState<OnlineRoom | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [renderSnapshot, setRenderSnapshot] = useState<RenderSnapshot | null>(null);
  const [celebrationSeed, setCelebrationSeed] = useState(0);

  const resizeCanvasToViewport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    return canvas;
  }, []);

  const isHost = useMemo(() => {
    return Boolean(match && myUserId && match.players.host.userId === myUserId);
  }, [match, myUserId]);

  const p1SkinDef = useMemo(() => getSkinDef(match?.players.host.skinId || 'default'), [match?.players.host.skinId]);
  const p2SkinDef = useMemo(() => getSkinDef(match?.players.guest?.skinId || 'default'), [match?.players.guest?.skinId]);

  const syncMatchState = useCallback((nextMatch: OnlineMatch) => {
    if (!shouldAcceptIncomingMatch(latestMatchRef.current, nextMatch)) {
      return;
    }
    latestMatchRef.current = nextMatch;
    setMatch(nextMatch);
  }, []);

  const syncRoomState = useCallback((nextRoom: OnlineRoom) => {
    latestRoomRef.current = nextRoom;
    setRoom(nextRoom);
  }, []);

  const initialiseRound = useCallback((activeMatch: OnlineMatch, roundNumber: number) => {
    const canvas = resizeCanvasToViewport();
    if (!canvas) return;

    const seed = (activeMatch.seed || 1) + ((roundNumber - 1) * 9973);
    currentSeedRef.current = seed;
    tickRef.current = 0;
    localInputRef.current.held = false;
    localInputRef.current.pendingPress = false;
    remoteInputRef.current.held = false;
    remoteInputRef.current.pendingPress = false;
    currentRoundResultRef.current = null;
    finishWindowRef.current = { active: false, survivor: null, ticksRemaining: 0 };
    phaseRef.current = 'COUNTDOWN';
    countdownValueRef.current = COUNTDOWN_SECONDS;
    countdownStartedAtRef.current = Date.now();
    phaseStartedAtRef.current = Date.now();

    const halfH = Math.floor(canvas.height / 2) - 2;
    hostStateRef.current = createPlayerState(createSeededRNG(seed), canvas.width, halfH, activeMatch.config.powerUpMode, 0, 0);
    guestStateRef.current = createPlayerState(createSeededRNG(seed), canvas.width, halfH, activeMatch.config.powerUpMode, 0, 0);

    setRenderSnapshot({
      tick: 0,
      phase: 'COUNTDOWN',
      countdownValue: COUNTDOWN_SECONDS,
      p1: cloneSerializableState(hostStateRef.current),
      p2: cloneSerializableState(guestStateRef.current),
      roundResult: null,
    });
  }, [resizeCanvasToViewport]);

  const computeWinner = useCallback((activeMatch: OnlineMatch, p1: PvpPlayerState, p2: PvpPlayerState): PvpRoundResult => {
    let winner: 0 | 1 | 2;
    if (activeMatch.config.powerUpMode === 'score_attack') {
      if (!p1.alive && !p2.alive) {
        if (p1.score === p2.score) winner = 0;
        else winner = p1.score > p2.score ? 1 : 2;
      }
      else if (!p1.alive) winner = 2;
      else winner = 1;
    } else {
      if (!p1.alive && !p2.alive) {
        if (p1.score === p2.score) winner = 0;
        else winner = p1.score > p2.score ? 1 : 2;
      }
      else if (!p1.alive) winner = 2;
      else winner = 1;
    }

    return {
      winner,
      p1Score: p1.score,
      p2Score: p2.score,
      p1DeathCause: p1.deathCause,
      p2DeathCause: p2.deathCause,
    };
  }, []);

  const uploadHostState = useCallback(async (activeMatch: OnlineMatch, phase: PvpMatchPhase, snapshot: RenderSnapshot, winnerSlot: 1 | 2 | null = null) => {
    try {
      const nextSeries = activeMatch.series || {
        roundsPlayed: 0,
        p1Wins: 0,
        p2Wins: 0,
        roundsNeeded: roundsNeededForFormat(activeMatch.config.format),
        currentRound: 1,
        roundResults: [],
      };
      await onlinePvpAPI.updateMatchState(activeMatch.matchId, {
        phase,
        snapshot,
        series: nextSeries,
        winnerSlot,
      });
      // Host is authoritative — do NOT syncMatchState from the response.
      // Stale responses (due to network latency) can regress local state,
      // causing wrong winner display and lost round results.
    } catch {
      // best effort for alpha polling sync
    }
  }, []);

  const finishMatchIfNeeded = useCallback(async (
    activeMatch: OnlineMatch,
    result: PvpRoundResult,
    nextSeries: NonNullable<OnlineMatch['series']>,
    finalSnapshot: RenderSnapshot,
  ) => {
    const winnerSlot = getSeriesWinnerSlot(nextSeries);
    const winnerUserId = winnerSlot === 1 ? activeMatch.players.host.userId : winnerSlot === 2 ? activeMatch.players.guest?.userId || null : null;
    const loserUserId = winnerSlot === 1 ? activeMatch.players.guest?.userId || null : winnerSlot === 2 ? activeMatch.players.host.userId : null;
    const loserBet = winnerSlot === 1 ? activeMatch.config.p2Bet : winnerSlot === 2 ? activeMatch.config.p1Bet : { coins: 0, dolphins: 0, tubePieces: 0 };

    if (
      !settledBetRef.current &&
      activeMatch.config.betting &&
      winnerUserId &&
      loserUserId &&
      (loserBet.coins > 0 || loserBet.dolphins > 0 || loserBet.tubePieces > 0)
    ) {
      settledBetRef.current = true;
      try {
        await pvpAPI.settleBet({ winnerUserId, loserUserId, bet: loserBet });
      } catch {
        // best effort
      }
    }

    await onlinePvpAPI.updateMatchState(activeMatch.matchId, {
      phase: 'MATCH_RESULT',
      winnerSlot,
      series: nextSeries,
      snapshot: finalSnapshot,
    }).catch(() => undefined);
  }, []);

  const stepAuthoritativeSimulation = useCallback(async () => {
    const activeMatch = latestMatchRef.current;
    const p1 = hostStateRef.current;
    const p2 = guestStateRef.current;
    const canvas = canvasRef.current;
    if (!activeMatch || !p1 || !p2 || !canvas) return;

    if (phaseRef.current === 'COUNTDOWN') {
      const remaining = COUNTDOWN_SECONDS - Math.floor((Date.now() - countdownStartedAtRef.current) / 1000);
      countdownValueRef.current = Math.max(1, remaining);
      if ((Date.now() - countdownStartedAtRef.current) >= COUNTDOWN_SECONDS * 1000) {
        phaseRef.current = 'PLAYING';
        phaseStartedAtRef.current = Date.now();
        initAudio();
      }
    } else if (phaseRef.current === 'PLAYING') {
      const localState = localInputRef.current;
      const remoteState = remoteInputRef.current;

      if (localState.pendingPress) {
        const target = p1;
        target.jumpInputActive = true;
        target.jumpBufferTimer = Constants.JUMP_BUFFER_TIME;
        attemptJump(target, true, activeMatch.config.powerUpMode);
        localState.pendingPress = false;
      }
      p1.jumpInputActive = localState.held;

      if (remoteState.pendingPress) {
        const target = p2;
        target.jumpInputActive = true;
        target.jumpBufferTimer = Constants.JUMP_BUFFER_TIME;
        attemptJump(target, true, activeMatch.config.powerUpMode);
        remoteState.pendingPress = false;
      }
      p2.jumpInputActive = remoteState.held;

      const halfH = Math.floor(canvas.height / 2) - 2;
      p1.alive && updatePlayerState(p1, FIXED_DT, canvas.width, halfH, activeMatch.config.powerUpMode);
      p2.alive && updatePlayerState(p2, FIXED_DT, canvas.width, halfH, activeMatch.config.powerUpMode);

      if (!finishWindowRef.current.active) {
        if (!p1.alive && !p2.alive) {
          finishWindowRef.current = { active: true, survivor: null, ticksRemaining: 0 };
        } else if (!p1.alive && p2.alive) {
          finishWindowRef.current = { active: true, survivor: 2, ticksRemaining: WINNER_FINISH_WINDOW_TICKS };
        } else if (p1.alive && !p2.alive) {
          finishWindowRef.current = { active: true, survivor: 1, ticksRemaining: WINNER_FINISH_WINDOW_TICKS };
        }
      } else if (finishWindowRef.current.ticksRemaining > 0) {
        finishWindowRef.current.ticksRemaining -= 1;
      }

      const shouldResolveRound =
        (!p1.alive && !p2.alive) ||
        (finishWindowRef.current.active && finishWindowRef.current.ticksRemaining <= 0) ||
        (finishWindowRef.current.active && finishWindowRef.current.survivor === 1 && !p1.alive) ||
        (finishWindowRef.current.active && finishWindowRef.current.survivor === 2 && !p2.alive);

      if (shouldResolveRound) {
        const result = computeWinner(activeMatch, p1, p2);
        currentRoundResultRef.current = result;
        finishWindowRef.current = { active: false, survivor: null, ticksRemaining: 0 };
        phaseRef.current = 'ROUND_RESULT';
        phaseStartedAtRef.current = Date.now();

        const baseSeries = activeMatch.series || {
          roundsPlayed: 0,
          p1Wins: 0,
          p2Wins: 0,
          roundsNeeded: roundsNeededForFormat(activeMatch.config.format),
          currentRound: 1,
          roundResults: [],
        };
        const nextSeries = {
          ...baseSeries,
          roundsPlayed: baseSeries.roundsPlayed + 1,
          p1Wins: baseSeries.p1Wins + (result.winner === 1 ? 1 : 0),
          p2Wins: baseSeries.p2Wins + (result.winner === 2 ? 1 : 0),
          roundResults: [...baseSeries.roundResults, result],
        };
        latestMatchRef.current = {
          ...activeMatch,
          phase: 'ROUND_RESULT',
          series: nextSeries,
          updatedAt: Date.now(),
        };
        setMatch(latestMatchRef.current);

        const isSeriesOver =
          nextSeries.p1Wins >= nextSeries.roundsNeeded ||
          nextSeries.p2Wins >= nextSeries.roundsNeeded ||
          nextSeries.roundsPlayed >= (activeMatch.config.format === 'bo5' ? 5 : activeMatch.config.format === 'bo3' ? 3 : 1);

        if (isSeriesOver) {
          const matchWinnerSlot = getSeriesWinnerSlot(nextSeries);
          phaseRef.current = 'MATCH_RESULT';
          const finalSnapshot: RenderSnapshot = {
            tick: tickRef.current,
            phase: 'MATCH_RESULT',
            countdownValue: 0,
            p1: cloneSerializableState(hostStateRef.current!),
            p2: cloneSerializableState(guestStateRef.current!),
            roundResult: result,
          };
          latestMatchRef.current = {
            ...activeMatch,
            phase: 'MATCH_RESULT',
            series: nextSeries,
            snapshot: finalSnapshot,
            winnerSlot: matchWinnerSlot,
            updatedAt: Date.now(),
            completedAt: Date.now(),
          };
          setMatch(latestMatchRef.current);
          setRenderSnapshot(finalSnapshot);
          setCelebrationSeed((value) => value + 1);
          await finishMatchIfNeeded(activeMatch, result, nextSeries, finalSnapshot);
          // Send PvP result for achievement tracking (host)
          if (!sentPvpResultRef.current && matchWinnerSlot != null) {
            sentPvpResultRef.current = true;
            const won = matchWinnerSlot === 1; // host is always slot 1
            missionsAPI.postEvent({ type: 'pvp_result', won }).catch(() => undefined);
          }
        }
      }
    } else if (phaseRef.current === 'ROUND_RESULT') {
      const activeSeries = latestMatchRef.current?.series;
      if (activeSeries && (Date.now() - phaseStartedAtRef.current) >= ROUND_RESULT_MS) {
        const nextRound = activeSeries.currentRound + 1;
        latestMatchRef.current = {
          ...latestMatchRef.current!,
          phase: 'COUNTDOWN',
          series: { ...activeSeries, currentRound: nextRound },
        };
        syncMatchState(latestMatchRef.current);
        initialiseRound(latestMatchRef.current, nextRound);
      }
    }

    const snapshot: RenderSnapshot = {
      tick: tickRef.current,
      phase: phaseRef.current,
      countdownValue: phaseRef.current === 'COUNTDOWN' ? countdownValueRef.current : 0,
      p1: cloneSerializableState(hostStateRef.current!),
      p2: cloneSerializableState(guestStateRef.current!),
      roundResult: currentRoundResultRef.current,
    };
    setRenderSnapshot(snapshot);

    if ((Date.now() - snapshotPushAtRef.current) >= SNAPSHOT_PUSH_MS) {
      snapshotPushAtRef.current = Date.now();
      uploadHostState(latestMatchRef.current!, phaseRef.current, snapshot, latestMatchRef.current?.winnerSlot || null).catch(() => undefined);
    }
  }, [computeWinner, finishMatchIfNeeded, initialiseRound, syncMatchState, uploadHostState]);

  const drawFrame = useCallback((snapshot: RenderSnapshot) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const p1 = cloneSnapshotPlayer(snapshot.p1);
    const p2 = cloneSnapshotPlayer(snapshot.p2);
    const halfH = Math.floor(canvas.height / 2) - 2;
    const v1: Viewport = { x: 0, y: 0, width: canvas.width, height: halfH };
    const v2: Viewport = { x: 0, y: halfH + 4, width: canvas.width, height: halfH };

    drawPlayerWorld(ctx, p1 as PvpPlayerState, v1, p1SkinDef, null, null, null);
    drawPlayerWorld(ctx, p2 as PvpPlayerState, v2, p2SkinDef, null, null, null);
    drawDivider(ctx, canvas.width, halfH + 2);
    drawPlayerHUD(ctx, p1 as PvpPlayerState, v1, 'HOST', match?.config.powerUpMode || 'earned');
    drawPlayerHUD(ctx, p2 as PvpPlayerState, v2, 'GUEST', match?.config.powerUpMode || 'earned');
    drawRescueCountdown(ctx, p1 as PvpPlayerState, v1);
    drawRescueCountdown(ctx, p2 as PvpPlayerState, v2);
  }, [match?.config.powerUpMode, p1SkinDef, p2SkinDef]);

  useEffect(() => {
    const resize = () => {
      resizeCanvasToViewport();
    };
    if (!canvasRef.current) return;
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [resizeCanvasToViewport, loading]);

  useEffect(() => {
    const loadImg = (src: string) => {
      const img = new Image();
      img.src = src;
      return img;
    };
    loadImg(turtleRescueImgSrc);
    loadImg(turtleShellItemImgSrc);
    loadImg(tubeImgSrc);
    preloadSkinImages();
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!matchId) {
        setError('Missing match ID');
        setLoading(false);
        return;
      }

      try {
        const bootstrap = await onlinePvpAPI.bootstrap();
        const matchRes = await onlinePvpAPI.getMatch(matchId) as { match: OnlineMatch };
        const resolvedRoomId = roomId || matchRes.match.roomId;
        const roomRes = await onlinePvpAPI.getRoom(resolvedRoomId) as { room: OnlineRoom };
        if (cancelled) return;

        setMyUserId(bootstrap.user.userId);
        myUserIdRef.current = bootstrap.user.userId;
        syncMatchState(matchRes.match);
        syncRoomState(roomRes.room);
        settledBetRef.current = Boolean(matchRes.match.completedAt);
        sentPvpResultRef.current = Boolean(matchRes.match.completedAt);

        currentRoundResultRef.current = matchRes.match.snapshot?.roundResult || matchRes.match.series?.roundResults?.at(-1) || null;

        if (matchRes.match.players.host.userId === bootstrap.user.userId) {
          initialiseRound(matchRes.match, matchRes.match.series?.currentRound || 1);
        } else if (matchRes.match.snapshot) {
          setRenderSnapshot({
            ...matchRes.match.snapshot,
            p1: cloneSnapshotPlayer(matchRes.match.snapshot.p1),
            p2: cloneSnapshotPlayer(matchRes.match.snapshot.p2),
          });
        }

        setLoading(false);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load match');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialiseRound, matchId, roomId, syncMatchState, syncRoomState]);

  useEffect(() => {
    if (loading || error || !match) return;

    const hostSimActive = isHost && hostStateRef.current && guestStateRef.current;

    // Only update round result ref from match state for the GUEST,
    // or for the host before simulation starts.
    // The host manages this ref directly via computeWinner/initialiseRound.
    if (!hostSimActive) {
      currentRoundResultRef.current = match.snapshot?.roundResult || match.series?.roundResults?.at(-1) || null;
    }

    if (match.phase === 'MATCH_RESULT') {
      setCelebrationSeed((value) => (value === 0 ? 1 : value));
      // Send PvP result for achievement tracking (guest side, or host if missed above)
      if (!sentPvpResultRef.current && match.winnerSlot != null) {
        sentPvpResultRef.current = true;
        const won = isHost ? match.winnerSlot === 1 : match.winnerSlot === 2;
        missionsAPI.postEvent({ type: 'pvp_result', won }).catch(() => undefined);
      }
    }

    if (!canvasRef.current) return;

    // Only update renderSnapshot from match.snapshot for the GUEST,
    // or for the host before simulation starts.
    // The host creates its own renderSnapshot in the simulation loop.
    if (!hostSimActive && match.snapshot) {
      setRenderSnapshot({
        ...match.snapshot,
        p1: cloneSnapshotPlayer(match.snapshot.p1),
        p2: cloneSnapshotPlayer(match.snapshot.p2),
      });
    }

    if (!isHost) return;
    if (hostStateRef.current && guestStateRef.current) return;

    const roundNumber = match.series?.currentRound || 1;
    const seed = (match.seed || 1) + ((roundNumber - 1) * 9973);

    if (match.snapshot) {
      tickRef.current = match.snapshot.tick;
      phaseRef.current = match.snapshot.phase;
      countdownValueRef.current = match.snapshot.countdownValue;
      currentSeedRef.current = seed;

      hostStateRef.current = {
        ...cloneSnapshotPlayer(match.snapshot.p1),
        rng: createSeededRNG(seed),
      } as PvpPlayerState;
      guestStateRef.current = {
        ...cloneSnapshotPlayer(match.snapshot.p2),
        rng: createSeededRNG(seed),
      } as PvpPlayerState;
      return;
    }

    initialiseRound(match, roundNumber);
  }, [error, initialiseRound, isHost, loading, match]);

  useEffect(() => {
    if (loading || error || !matchId || !match) return;
    const interval = setInterval(async () => {
      try {
        const matchRes = await onlinePvpAPI.getMatch(matchId) as { match: OnlineMatch };
        const accepted = shouldAcceptIncomingMatch(latestMatchRef.current, matchRes.match);
        if (accepted) {
          syncMatchState(matchRes.match);
        }

        // Only update round result ref from polling for the GUEST.
        // The host manages this ref directly via its simulation loop.
        if (!isHost) {
          const incomingRounds = matchRes.match.series?.roundResults?.length || 0;
          const currentRounds = latestMatchRef.current?.series?.roundResults?.length || 0;
          if (accepted && incomingRounds >= currentRounds) {
            currentRoundResultRef.current = matchRes.match.snapshot?.roundResult || matchRes.match.series?.roundResults?.at(-1) || null;
          }
        }

        if (!isHost && accepted && matchRes.match.snapshot) {
          setRenderSnapshot({
            ...matchRes.match.snapshot,
            p1: cloneSnapshotPlayer(matchRes.match.snapshot.p1),
            p2: cloneSnapshotPlayer(matchRes.match.snapshot.p2),
          });
        }

        if (isHost) {
          const guestInputs = matchRes.match.inputs?.guest || [];
          for (const event of guestInputs) {
            if (event.seq <= lastGuestInputSeqRef.current) continue;
            lastGuestInputSeqRef.current = event.seq;
            if (event.action === 'down') {
              remoteInputRef.current.held = true;
              remoteInputRef.current.pendingPress = true;
            } else {
              remoteInputRef.current.held = false;
            }
          }
        }

        const resolvedRoomId = roomId || matchRes.match.roomId;
        if (resolvedRoomId) {
          const roomRes = await onlinePvpAPI.getRoom(resolvedRoomId) as { room: OnlineRoom };
          syncRoomState(roomRes.room);
        }
      } catch {
        // alpha best effort polling
      }
    }, MATCH_POLL_MS);
    return () => clearInterval(interval);
  }, [error, isHost, loading, match, matchId, roomId, syncMatchState, syncRoomState]);

  useEffect(() => {
    if (loading || error || !match || !isHost) return;

    const frame = (time: number) => {
      if (lastTimeRef.current === 0) {
        lastTimeRef.current = time;
      }
      const delta = Math.min((time - lastTimeRef.current) / 1000, 0.1);
      lastTimeRef.current = time;
      accumulatorRef.current += delta;

      while (accumulatorRef.current >= FIXED_DT) {
        tickRef.current += 1;
        stepAuthoritativeSimulation().catch(() => undefined);
        accumulatorRef.current -= FIXED_DT;
      }

      const snapshot = renderSnapshot;
      if (snapshot) {
        drawFrame(snapshot);
      }
      animationRef.current = requestAnimationFrame(frame);
    };

    animationRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationRef.current);
  }, [drawFrame, error, isHost, loading, match, renderSnapshot, stepAuthoritativeSimulation]);

  useEffect(() => {
    if (loading || error || isHost) return;
    const frame = () => {
      if (renderSnapshot) {
        drawFrame(renderSnapshot);
      }
      animationRef.current = requestAnimationFrame(frame);
    };
    animationRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animationRef.current);
  }, [drawFrame, error, isHost, loading, renderSnapshot]);

  useEffect(() => {
    if (!match || !matchId) return;

    const isInteractiveTarget = (target: EventTarget | null) => (
      target instanceof HTMLElement &&
      Boolean(target.closest('button, input, select, textarea, a, [data-ui-interactive="true"]'))
    );

    const sendInput = (action: 'down' | 'up') => {
      localInputRef.current.seq += 1;
      if (action === 'down') {
        localInputRef.current.held = true;
        localInputRef.current.pendingPress = true;
      } else {
        localInputRef.current.held = false;
      }

      if (!isHost) {
        onlinePvpAPI.sendMatchInput(matchId, localInputRef.current.seq, action).catch(() => undefined);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.repeat) return;
      if (event.code !== 'Space' && event.code !== 'ArrowUp') return;
      event.preventDefault();
      sendInput('down');
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      if (event.code !== 'Space' && event.code !== 'ArrowUp') return;
      event.preventDefault();
      sendInput('up');
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      sendInput('down');
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      sendInput('up');
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('touchstart', handleTouchStart, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: false });

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isHost, match, matchId]);

  const handleExitToLobby = useCallback(async () => {
    const liveRoom = latestRoomRef.current;
    if (liveRoom) {
      try {
        await onlinePvpAPI.leaveRoom(liveRoom.roomId, liveRoom.version);
      } catch {
        // best effort
      }
    }
    onBackToLobby();
  }, [onBackToLobby]);

  const handleReturnToRoom = useCallback(() => {
    const targetRoomId = latestRoomRef.current?.roomId || roomId || match?.roomId;
    if (!targetRoomId) {
      onBackToLobby();
      return;
    }
    onReturnToRoom(targetRoomId);
  }, [match?.roomId, onBackToLobby, onReturnToRoom, roomId]);

  useEffect(() => {
    if (match?.phase !== 'MATCH_RESULT' || !match.completedAt) return;
    const timer = window.setTimeout(() => {
      handleReturnToRoom();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [handleReturnToRoom, match?.completedAt, match?.phase]);

  const seriesState = match?.series || {
    roundsPlayed: 0,
    p1Wins: 0,
    p2Wins: 0,
    roundsNeeded: match ? roundsNeededForFormat(match.config.format) : 1,
    currentRound: 1,
    roundResults: [],
  };
  const seriesWinnerSlot = getSeriesWinnerSlot(seriesState);
  const winnerSlot = match?.phase === 'MATCH_RESULT'
    ? (match?.winnerSlot ?? seriesWinnerSlot)
    : ((currentRoundResultRef.current?.winner === 1 || currentRoundResultRef.current?.winner === 2) ? currentRoundResultRef.current.winner : null);
  const localWon = winnerSlot
    ? (isHost ? winnerSlot === 1 : winnerSlot === 2)
    : false;
  const activeRoundResult = renderSnapshot?.roundResult || currentRoundResultRef.current;
  const isDrawResult = match?.phase === 'MATCH_RESULT' && winnerSlot === null;
  const totalRounds = match ? maxRoundsForFormat(match.config.format) : 1;
  const localSeriesWins = isHost ? seriesState.p1Wins : seriesState.p2Wins;
  const opponentSeriesWins = isHost ? seriesState.p2Wins : seriesState.p1Wins;
  const localRoundScore = activeRoundResult ? (isHost ? activeRoundResult.p1Score : activeRoundResult.p2Score) : 0;
  const opponentRoundScore = activeRoundResult ? (isHost ? activeRoundResult.p2Score : activeRoundResult.p1Score) : 0;
  const roundPerspectiveText = activeRoundResult
    ? activeRoundResult.winner === 0
      ? 'DRAW ROUND'
      : (isHost ? activeRoundResult.winner === 1 : activeRoundResult.winner === 2)
        ? 'YOU WIN THIS ROUND'
        : 'YOU LOSE THIS ROUND'
    : null;
  const roundPerspectiveColor = activeRoundResult?.winner === 0
    ? '#ffd166'
    : roundPerspectiveText === 'YOU WIN THIS ROUND'
      ? '#00ff88'
      : '#ff8844';
  const completedRounds = seriesState.roundResults.map((round, index) => ({
    roundNumber: index + 1,
    localScore: isHost ? round.p1Score : round.p2Score,
    opponentScore: isHost ? round.p2Score : round.p1Score,
    outcome: round.winner === 0 ? 'DRAW' : ((isHost ? round.winner === 1 : round.winner === 2) ? 'WIN' : 'LOSE'),
  }));
  const isRoundFinishWindowActive = phaseRef.current === 'PLAYING' && finishWindowRef.current.active && finishWindowRef.current.ticksRemaining > 0;
  const finishWindowSecondsLeft = Math.max(1, Math.ceil(finishWindowRef.current.ticksRemaining * FIXED_DT));

  const celebrationBits = useMemo(() => (
    Array.from({ length: 18 }, (_, index) => ({
      id: `${celebrationSeed}-${index}`,
      left: `${(index * 37) % 100}%`,
      delay: `${(index % 6) * 0.12}s`,
      color: index % 2 === 0 ? '#00ff88' : '#00ccff',
    }))
  ), [celebrationSeed]);

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    background: '#001428',
    overflow: 'hidden',
  };

  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'monospace',
    color: 'white',
    textAlign: 'center',
    background: 'rgba(0, 10, 25, 0.75)',
    zIndex: 10,
  };

  const buttonStyle: React.CSSProperties = {
    padding: '14px 28px',
    borderRadius: 12,
    border: '2px solid rgba(0, 180, 255, 0.45)',
    background: 'rgba(0, 180, 255, 0.22)',
    color: 'white',
    fontWeight: 800,
    fontFamily: 'monospace',
    cursor: 'pointer',
  };

  if (loading) {
    return (
      <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontFamily: 'monospace' }}>
        Loading online match...
      </div>
    );
  }

  if (error || !match) {
    return (
      <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: 'white', fontFamily: 'monospace' }}>
        <div style={{ color: '#ff6666' }}>{error || 'Match not found'}</div>
        <button style={{ ...buttonStyle, marginTop: 16 }} onClick={handleExitToLobby}>BACK TO LOBBY</button>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      {(renderSnapshot?.phase === 'COUNTDOWN' || match.phase === 'COUNTDOWN') && (
        <div style={overlayStyle}>
          <div style={{ fontSize: 'clamp(64px, 16vw, 160px)', fontWeight: 900 }}>
            {renderSnapshot?.countdownValue || COUNTDOWN_SECONDS}
          </div>
          <div style={{ marginTop: 12, color: '#7fbfff' }}>
            {isHost ? 'You are driving the authoritative match.' : 'Waiting for host sync...'}
          </div>
        </div>
      )}

      {renderSnapshot?.phase === 'ROUND_RESULT' && activeRoundResult && (
        <div style={overlayStyle}>
          <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#00ccff' }}>
            ROUND {seriesState.roundsPlayed} COMPLETE
          </div>
          <div style={{ marginTop: 10, fontSize: 'clamp(28px, 6vw, 52px)', fontWeight: 900, color: roundPerspectiveColor }}>
            {roundPerspectiveText}
          </div>
          <div style={{ marginTop: 12, fontSize: '1rem', color: '#ddd' }}>
            This round: You {localRoundScore} / Opponent {opponentRoundScore}
          </div>
          <div style={{ marginTop: 8, fontSize: '0.95rem', color: '#cfd8dc' }}>
            Series: You {localSeriesWins} - Opponent {opponentSeriesWins}
          </div>
        </div>
      )}

      {match.phase === 'MATCH_RESULT' && (
        <div style={{ ...overlayStyle, background: 'rgba(0, 10, 25, 0.84)' }}>
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
            {celebrationBits.map((bit) => (
              <div
                key={bit.id}
                style={{
                  position: 'absolute',
                  left: bit.left,
                  top: -20,
                  width: 10,
                  height: 26,
                  borderRadius: 6,
                  background: bit.color,
                  opacity: 0.85,
                  animation: `invite-confetti 2.4s linear ${bit.delay} infinite`,
                }}
              />
            ))}
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 800, color: '#00ccff' }}>MATCH COMPLETE</div>
          <div style={{ marginTop: 10, fontSize: 'clamp(32px, 7vw, 62px)', fontWeight: 900, color: isDrawResult ? '#ffd166' : localWon ? '#00ff88' : '#ff8844' }}>
            {isDrawResult ? 'DRAW' : localWon ? 'YOU WIN' : 'YOU LOSE'}
          </div>
          <div style={{ marginTop: 12, fontSize: '1.05rem', color: '#fff' }}>
            {isDrawResult ? 'Both players finished tied.' : localWon ? 'You take the match.' : 'Opponent takes the match.'}
          </div>
          <div style={{ marginTop: 8, color: '#cfd8dc' }}>
            Final series: You {localSeriesWins} - Opponent {opponentSeriesWins}
          </div>
          <div style={{ marginTop: 16, display: 'grid', gap: 8, width: 'min(420px, 86vw)', maxHeight: '32vh', overflowY: 'auto', paddingRight: 4 }}>
            {completedRounds.map((round) => (
              <div
                key={round.roundNumber}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  fontSize: '0.92rem',
                }}
              >
                <span>Round {round.roundNumber}</span>
                <span>You {round.localScore} - {round.opponentScore} Opponent</span>
                <span style={{ color: round.outcome === 'WIN' ? '#00ff88' : round.outcome === 'LOSE' ? '#ff8844' : '#ffd166' }}>
                  {round.outcome}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button style={buttonStyle} onClick={handleReturnToRoom}>RETURN TO ROOM</button>
            <button style={{ ...buttonStyle, background: 'rgba(200, 50, 50, 0.2)', borderColor: 'rgba(200, 50, 50, 0.45)' }} onClick={handleExitToLobby}>
              EXIT TO LOBBY
            </button>
          </div>
        </div>
      )}

      {match.phase !== 'MATCH_RESULT' && renderSnapshot?.phase !== 'COUNTDOWN' && (
        <div style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: '8px 12px',
          borderRadius: 12,
          background: 'rgba(0, 0, 0, 0.28)',
          color: 'white',
          fontFamily: 'monospace',
          fontSize: '0.8rem',
          zIndex: 8,
          display: 'grid',
          gap: 4,
        }}>
          <div>{isHost ? 'HOST' : 'GUEST'} · {match.config.format} · {match.config.powerUpMode}</div>
          <div>Round {Math.min(seriesState.currentRound, totalRounds)} / {totalRounds}</div>
          <div>Series: You {localSeriesWins} - Opponent {opponentSeriesWins}</div>
          {isRoundFinishWindowActive && (
            <div style={{ color: '#ffd166' }}>
              Finish window: {finishWindowSecondsLeft}s
            </div>
          )}
        </div>
      )}
    </div>
  );
};
