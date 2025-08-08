import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type FC,
} from 'react';
import { BrowserMultiFormatReader, BarcodeFormat } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';

type CameraDevice = {
  deviceId: string;
  label: string;
};

type CodeScannerProps = {
  onResult?: (text: string, raw: unknown) => void;
  onError?: (err: Error) => void;
  className?: string;
};

type CameraMode = 'back-main' | 'back-wide' | 'front' | 'auto'; // auto used for first startup/fallback

const CodeScanner: FC<CodeScannerProps> = ({
  onResult,
  onError,
  className = '',
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<
    'granted' | 'denied' | 'prompt' | 'unknown'
  >('unknown');

  const [mode, setMode] = useState<CameraMode>('auto');

  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const mountedRef = useRef(true);
  const hasAutoStartedRef = useRef(false);

  // Cache of probed device capabilities to help distinguish main vs ultra-wide
  const deviceInfoRef = useRef<
    Map<string, { facingMode?: string; zoomMax?: number; zoomMin?: number }>
  >(new Map());

  // Decode control flags
  const pausedRef = useRef(false);
  const lastResultAtRef = useRef(0);

  const stopActiveStream = (videoEl: HTMLVideoElement | null) => {
    const stream = (videoEl?.srcObject as MediaStream | null) ?? null;
    if (stream) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      if (videoEl) videoEl.srcObject = null;
    }
  };

  useEffect(() => {
    // Configure reader with narrowed formats and faster scan loop
    readerRef.current = new BrowserMultiFormatReader(undefined, {
      delayBetweenScanAttempts: 120,
      delayBetweenScanSuccess: 600,
      tryPlayVideoTimeout: 4000,
    });
    // Prefer common 1D formats + QR. This improves reliability and performance on mobile
    readerRef.current.possibleFormats = [
      BarcodeFormat.QR_CODE,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.ITF,
      BarcodeFormat.PDF_417,
      BarcodeFormat.DATA_MATRIX,
      BarcodeFormat.AZTEC,
    ];

    const onVis = () => {
      pausedRef.current = document.hidden;
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVis);
      try {
        controlsRef.current?.stop();
      } finally {
        stopActiveStream(videoRef.current);
      }
    };
  }, []);

  const handleError = useCallback(
    (err: unknown) => {
      if (!mountedRef.current) return;
      const e = err instanceof Error ? err : new Error(String(err));
      onError?.(e);
    },
    [onError]
  );

  const checkPermissions = useCallback(async () => {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const permission = await navigator.permissions.query({
          name: 'camera' as PermissionName,
        });
        setPermissionStatus(permission.state);
        permission.addEventListener('change', () => {
          setPermissionStatus(permission.state);
        });
        if (permission.state === 'denied') {
          throw new Error(
            'Camera permission denied. Please enable camera access in your browser settings.'
          );
        }
      }
    } catch {
      // ignore
    }
  }, []);

  const categorizeCameras = useCallback((cams: CameraDevice[]) => {
    // Heuristics: label parsing to prefer back/front and wide/main
    const isBack = (s: string) =>
      /back|rear|environment/i.test(s) ||
      (/camera/i.test(s) && !/front|user|face/i.test(s));
    const isFront = (s: string) => /front|user|face/i.test(s);
    const isWide = (s: string) =>
      /ultra|ultra-wide|ultrawide|wide|0\.5x|0,5x|0x5|0_5x/i.test(s);

    const back = cams.filter((c) => isBack(c.label));
    const front = cams.filter((c) => isFront(c.label));
    const backWide = back.filter((c) => isWide(c.label));
    const backMain = back.filter((c) => !isWide(c.label));

    const pickBackMain = backMain[0] || back[0] || cams[0];
    const pickBackWide = backWide[0] || null;
    const pickFront = front[0] || null;

    return { pickBackMain, pickBackWide, pickFront };
  }, []);

  const probeDeviceInfo = useCallback(async (deviceId: string) => {
    if (deviceInfoRef.current.has(deviceId))
      return deviceInfoRef.current.get(deviceId)!;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: deviceId } },
      });
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings?.() || {};
      const caps = (track.getCapabilities?.() as any) || {};
      const info = {
        facingMode: (settings as any).facingMode as string | undefined,
        zoomMax:
          typeof caps?.zoom?.max === 'number' ? caps.zoom.max : undefined,
        zoomMin:
          typeof caps?.zoom?.min === 'number' ? caps.zoom.min : undefined,
      } as { facingMode?: string; zoomMax?: number; zoomMin?: number };
      deviceInfoRef.current.set(deviceId, info);
      return info;
    } catch {
      const info = {
        facingMode: undefined,
        zoomMax: undefined,
        zoomMin: undefined,
      };
      deviceInfoRef.current.set(deviceId, info);
      return info;
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
  }, []);

  const enumerateAfterAccess = useCallback(async () => {
    const allAfter = await navigator.mediaDevices.enumerateDevices();
    const camsAfter = allAfter
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
      }));
    return camsAfter;
  }, []);

  const initDevices = useCallback(async () => {
    try {
      await checkPermissions();

      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        throw new Error('Media devices API not supported in this browser.');
      }

      const all = await navigator.mediaDevices.enumerateDevices();
      let cams = all
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));

      if (!mountedRef.current) return;

      if (cams.length === 0) {
        let testStream: MediaStream | null = null;
        try {
          testStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
          });
          setPermissionStatus('granted');
          cams = await enumerateAfterAccess();
        } catch (e: any) {
          if (e?.name === 'NotAllowedError') {
            setPermissionStatus('denied');
            throw new Error(
              'Camera access denied. Please allow camera permissions and refresh the page.'
            );
          } else if (e?.name === 'NotFoundError') {
            throw new Error('No camera found on this device.');
          } else if (e?.name === 'NotSupportedError') {
            throw new Error('Camera not supported on this device.');
          } else {
            throw new Error(`Camera access failed: ${e?.message || e}`);
          }
        } finally {
          if (testStream) {
            testStream.getTracks().forEach((t) => t.stop());
          }
        }

        if (cams.length === 0) {
          throw new Error('No camera devices found even after permission.');
        }
      }

      setDevices(cams);

      // Initial selection heuristic
      const { pickBackMain } = categorizeCameras(cams);
      setSelectedDeviceId(pickBackMain.deviceId);
      setMode('back-main');
    } catch (e) {
      handleError(e);
    }
  }, [checkPermissions, enumerateAfterAccess, categorizeCameras, handleError]);

  useEffect(() => {
    initDevices();
  }, [initDevices]);

  const detectTorchSupport = useCallback(async () => {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track || !mountedRef.current) {
        setTorchSupported(false);
        return;
      }
      let supported = false;
      if (track.getCapabilities) {
        const caps = track.getCapabilities() as any;
        supported = Boolean(caps?.torch);
      }
      if (!supported && 'ImageCapture' in window) {
        try {
          const ic = new (window as any).ImageCapture(track);
          const photo = await ic.getPhotoCapabilities();
          supported =
            Array.isArray(photo?.fillLightMode) &&
            (photo.fillLightMode.includes('flash') ||
              photo.fillLightMode.includes('torch'));
        } catch {
          /* ignore */
        }
      }
      if (mountedRef.current) setTorchSupported(supported);
    } catch {
      if (mountedRef.current) setTorchSupported(false);
    }
  }, []);

  const onDecode = useCallback(
    (result: any, err: any) => {
      if (!mountedRef.current || pausedRef.current) return;

      if (result) {
        const now = performance.now();
        if (now - lastResultAtRef.current > 500) {
          lastResultAtRef.current = now;
          onResult?.(result.getText(), result);
          if (
            'vibrate' in navigator &&
            typeof navigator.vibrate === 'function'
          ) {
            navigator.vibrate(30);
          }
        }
      } else if (err && err.name !== 'NotFoundException') {
        // ignore transient errors
      }
    },
    [onResult]
  );

  // Best-effort lens selection using zoom constraints (helps on Android)
  const adjustLensForMode = useCallback(async (desiredMode: CameraMode) => {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track || !track.getCapabilities || !track.applyConstraints) return;
      const caps = track.getCapabilities() as any;
      if (!caps) return;
      const zoomCaps = caps.zoom;
      const hasZoomRange =
        typeof zoomCaps === 'object' &&
        zoomCaps !== null &&
        (typeof zoomCaps.min === 'number' || typeof zoomCaps.max === 'number');
      if (!hasZoomRange) return;

      const min = Number.isFinite(zoomCaps.min) ? zoomCaps.min : 0;
      const max = Number.isFinite(zoomCaps.max) ? zoomCaps.max : 0;
      const clamp = (v: number) => Math.max(min, Math.min(max, v));

      if (desiredMode === 'back-wide') {
        // Prefer minimum zoom to emulate ultrawide
        await track.applyConstraints({
          advanced: [{ zoom: clamp(min) as any }],
        } as any);
      } else if (desiredMode === 'back-main') {
        // Prefer ~1x if available; otherwise midpoint
        const target = min <= 1 && 1 <= max ? 1 : (min + max) / 2;
        await track.applyConstraints({
          advanced: [{ zoom: clamp(target) as any }],
        } as any);
      }
    } catch {
      // ignore best-effort errors
    }
  }, []);

  // Determine available camera modes from discovered devices
  const cameraAvailability = useMemo(() => {
    const result = {
      hasBackMain: false,
      hasBackWide: false,
      hasFront: false,
      showSelector: false,
    };
    if (!devices || devices.length === 0) return result;

    // Heuristics should mirror categorizeCameras
    const isBack = (s: string) =>
      /back|rear|environment/i.test(s) ||
      (/camera/i.test(s) && !/front|user|face/i.test(s));
    const isFront = (s: string) => /front|user|face/i.test(s);
    const isWide = (s: string) =>
      /ultra|ultra-wide|ultrawide|wide|0\.5x|0,5x|0x5|0_5x/i.test(s);

    const backs = devices.filter((d) => isBack(d.label));
    const fronts = devices.filter((d) => isFront(d.label));
    const backWides = backs.filter((d) => isWide(d.label));
    const backMains = backs.filter((d) => !isWide(d.label));

    result.hasFront = fronts.length > 0;
    result.hasBackMain = backMains.length > 0;
    result.hasBackWide = backWides.length > 0;

    const availableModesCount = [
      result.hasBackMain,
      result.hasBackWide,
      result.hasFront,
    ].filter(Boolean).length;

    // Hide selector if only one physical camera or only one meaningful mode available
    result.showSelector = devices.length > 1 && availableModesCount > 1;
    return result;
  }, [devices]);

  const currentDeviceLabel = useMemo(() => {
    if (!selectedDeviceId) return '';
    return devices.find((d) => d.deviceId === selectedDeviceId)?.label || '';
  }, [devices, selectedDeviceId]);

  const buildConstraints = useCallback(
    (desiredMode: CameraMode, deviceId?: string): MediaStreamConstraints => {
      // Strategy:
      // - Prefer deviceId if provided (Android/Chrome and many Android browsers)
      // - For iOS/Safari, facingMode is often more reliable; deviceId switching
      //   might not always work, but we'll still try when we have it.
      const base = {
        audio: false,
        video: {
          frameRate: { ideal: 24, max: 24 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        } as MediaTrackConstraints,
      };

      const useFacingEnv = {
        ...(base.video as any),
        facingMode: 'environment',
      };
      const useFacingUser = { ...(base.video as any), facingMode: 'user' };

      if (desiredMode === 'front') {
        // Prefer deviceId if we know a front camera device
        if (deviceId) {
          return {
            audio: false,
            video: { ...(base.video as any), deviceId: { exact: deviceId } },
          };
        }
        return { audio: false, video: useFacingUser };
      }

      // back-main or back-wide or auto
      if (deviceId) {
        return {
          audio: false,
          video: { ...(base.video as any), deviceId: { exact: deviceId } },
        };
      }
      return { audio: false, video: useFacingEnv };
    },
    []
  );

  const pickDeviceIdForMode = useCallback(
    async (
      desiredMode: CameraMode,
      deviceList?: CameraDevice[]
    ): Promise<string | undefined> => {
      const list = deviceList && deviceList.length > 0 ? deviceList : devices;
      if (!list || list.length === 0) return undefined;

      const { pickBackMain, pickBackWide, pickFront } = categorizeCameras(list);

      if (desiredMode === 'front') {
        if (pickFront) return pickFront.deviceId;
        // As a fallback, probe all devices and pick one reported as user-facing
        for (const d of list) {
          const info = await probeDeviceInfo(d.deviceId);
          if (/user|front/i.test(info.facingMode || '')) return d.deviceId;
        }
        return undefined;
      }

      // back-wide explicit
      if (desiredMode === 'back-wide') {
        if (pickBackWide) return pickBackWide.deviceId;
        // disambiguate by zoom: wide lenses tend to have a lower max zoom
        const candidates = list.filter(
          (c) =>
            /back|rear|environment/i.test(c.label) ||
            !/front|user|face/i.test(c.label)
        );
        if (candidates.length >= 2) {
          let chosen: { id: string; zoomMax: number } | null = null;
          for (const d of candidates) {
            const info = await probeDeviceInfo(d.deviceId);
            const z = Number.isFinite(info.zoomMax as any)
              ? (info.zoomMax as number)
              : -1;
            if (chosen === null || z < chosen.zoomMax)
              chosen = { id: d.deviceId, zoomMax: z };
          }
          return chosen?.id || pickBackMain?.deviceId || undefined;
        }
        return pickBackMain?.deviceId || undefined;
      }

      // back-main or auto
      if (pickBackMain) return pickBackMain.deviceId;
      if (pickBackWide) return pickBackWide.deviceId;
      // disambiguate by zoom: main lens usually has higher max zoom
      const candidates = list.filter(
        (c) =>
          /back|rear|environment/i.test(c.label) ||
          !/front|user|face/i.test(c.label)
      );
      if (candidates.length >= 2) {
        let chosen: { id: string; zoomMax: number } | null = null;
        for (const d of candidates) {
          const info = await probeDeviceInfo(d.deviceId);
          const z = Number.isFinite(info.zoomMax as any)
            ? (info.zoomMax as number)
            : -1;
          if (chosen === null || z > chosen.zoomMax)
            chosen = { id: d.deviceId, zoomMax: z };
        }
        return chosen?.id || candidates[0]?.deviceId;
      }
      return candidates[0]?.deviceId;
    },
    [devices, categorizeCameras, probeDeviceInfo]
  );

  const start = useCallback(
    async (desiredMode: CameraMode = mode) => {
      if (!videoRef.current || !readerRef.current) return;
      if (isStarting || isRunning) return;

      if (permissionStatus === 'denied') {
        handleError(
          new Error(
            'Camera permission denied. Please allow camera access in your browser settings.'
          )
        );
        return;
      }

      try {
        setIsStarting(true);
        setTorchOn(false);
        setTorchSupported(false);
        pausedRef.current = false;

        controlsRef.current?.stop();
        controlsRef.current = null;
        stopActiveStream(videoRef.current);

        const picked =
          desiredMode === 'auto'
            ? selectedDeviceId
            : await pickDeviceIdForMode(desiredMode);
        // For front mode, avoid falling back to a back camera deviceId
        const plannedDeviceId =
          desiredMode === 'front'
            ? picked
            : picked || selectedDeviceId || undefined;

        const constraintsPrimary = buildConstraints(
          desiredMode,
          plannedDeviceId
        );

        let controls: IScannerControls | null = null;
        try {
          controls = await readerRef.current.decodeFromConstraints(
            constraintsPrimary,
            videoRef.current,
            onDecode
          );
        } catch (e: any) {
          // Fallbacks
          try {
            // Try facingMode-based fallback
            const fallbackConstraints = buildConstraints(
              desiredMode,
              undefined
            );
            controls = await readerRef.current.decodeFromConstraints(
              fallbackConstraints,
              videoRef.current,
              onDecode
            );
          } catch {
            // Final basic fallback
            controls = await readerRef.current.decodeFromConstraints(
              { audio: false, video: true },
              videoRef.current,
              onDecode
            );
          }
        }

        if (!mountedRef.current) {
          controls?.stop();
          stopActiveStream(videoRef.current);
          return;
        }
        if (!controls) throw new Error('Failed to start scanner');

        controlsRef.current = controls;

        const video = videoRef.current;
        await new Promise<void>((resolve) => {
          if (video.readyState >= 1) resolve();
          else {
            const onLoaded = () => {
              video.removeEventListener('loadedmetadata', onLoaded);
              resolve();
            };
            video.addEventListener('loadedmetadata', onLoaded, { once: true });
          }
        });
        try {
          await video.play();
        } catch {
          /* may require user gesture */
        }

        setIsRunning(true);

        setTimeout(() => {
          if (!mountedRef.current) return;
          // Prefer using ZXing-provided switchTorch controls when available
          const hasSwitch =
            typeof controlsRef.current?.switchTorch === 'function';
          if (hasSwitch) setTorchSupported(true);
          else detectTorchSupport();
        }, 300);

        // Adjust zoom after stream is live to better match main/wide
        setTimeout(() => {
          if (!mountedRef.current) return;
          void adjustLensForMode(
            desiredMode === 'auto' ? 'back-main' : desiredMode
          );
        }, 350);

        if (plannedDeviceId) setSelectedDeviceId(plannedDeviceId);
        setMode(desiredMode === 'auto' ? 'back-main' : desiredMode);
      } catch (e) {
        handleError(e);
        if (mountedRef.current) setIsRunning(false);
      } finally {
        if (mountedRef.current) setIsStarting(false);
      }
    },
    [
      isStarting,
      isRunning,
      permissionStatus,
      handleError,
      detectTorchSupport,
      onDecode,
      mode,
      selectedDeviceId,
      buildConstraints,
      pickDeviceIdForMode,
    ]
  );

  const stop = useCallback(() => {
    pausedRef.current = true;
    controlsRef.current?.stop();
    controlsRef.current = null;
    stopActiveStream(videoRef.current);
    setIsRunning(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  // One-time autostart after devices are initialized
  useEffect(() => {
    if (!mountedRef.current) return;
    if (hasAutoStartedRef.current) return;
    if (!selectedDeviceId) return;
    hasAutoStartedRef.current = true;
    void start('back-main');
  }, [selectedDeviceId, start]);

  const toggleTorch = useCallback(async () => {
    if (!isRunning || !torchSupported) return;
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track) return;

      const next = !torchOn;
      // Prefer ZXing control if available
      if (controlsRef.current?.switchTorch) {
        await controlsRef.current.switchTorch(next);
        if (mountedRef.current) setTorchOn(next);
        return;
      }

      try {
        await track.applyConstraints({ advanced: [{ torch: next } as any] });
        if (mountedRef.current) setTorchOn(next);
        return;
      } catch {
        // fallback
      }

      if ('ImageCapture' in window) {
        try {
          const ic = new (window as any).ImageCapture(track);
          if (ic.setOptions) {
            await ic.setOptions({
              fillLightMode: next ? 'torch' : 'off',
            });
            if (mountedRef.current) setTorchOn(next);
            return;
          }
        } catch {
          /* ignore */
        }
      }

      throw new Error('Torch control not supported');
    } catch (e) {
      handleError(e);
    }
  }, [isRunning, torchSupported, torchOn, handleError]);

  // Button handlers for camera modes
  const switchToBackMain = useCallback(() => {
    stop();
    start('back-main');
  }, [start, stop]);

  const switchToBackWide = useCallback(() => {
    stop();
    start('back-wide');
  }, [start, stop]);

  const switchToFront = useCallback(() => {
    stop();
    start('front');
  }, [start, stop]);

  const retryInit = useCallback(() => {
    setDevices([]);
    setSelectedDeviceId('');
    setMode('auto');
    initDevices();
  }, [initDevices]);

  return (
    <div
      className={`w-full max-w-md mx-auto space-y-3 bg-white rounded-xl shadow p-4 ${className}`}
    >
      {/* Camera mode buttons */}
      {cameraAvailability.showSelector && (
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-sm font-medium text-gray-700'>Camera mode</span>
          <div
            className='inline-flex rounded-lg bg-gray-100 p-1 shadow-sm ring-1 ring-gray-200'
            role='group'
            aria-label='Camera mode'
          >
            {cameraAvailability.hasBackMain && (
              <button
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  mode === 'back-main'
                    ? 'bg-white text-gray-900 shadow'
                    : 'text-gray-700 hover:bg-gray-200'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                onClick={switchToBackMain}
                disabled={isStarting}
                title='Back main camera'
              >
                🎥 Back
              </button>
            )}
            {cameraAvailability.hasBackWide && (
              <button
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  mode === 'back-wide'
                    ? 'bg-white text-gray-900 shadow'
                    : 'text-gray-700 hover:bg-gray-200'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                onClick={switchToBackWide}
                disabled={isStarting}
                title='Back wide/ultra-wide camera'
              >
                🔭 Wide
              </button>
            )}
            {cameraAvailability.hasFront && (
              <button
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  mode === 'front'
                    ? 'bg-white text-gray-900 shadow'
                    : 'text-gray-700 hover:bg-gray-200'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                onClick={switchToFront}
                disabled={isStarting}
                title='Front/selfie camera'
              >
                🤳 Front
              </button>
            )}
          </div>
        </div>
      )}

      {(permissionStatus === 'denied' || devices.length === 0) && (
        <div className='flex flex-wrap items-center gap-2'>
          <button
            className='rounded bg-orange-500 px-3 py-2 text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={retryInit}
            disabled={isStarting}
          >
            Retry
          </button>
        </div>
      )}

      <div className='relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-black'>
        <video
          ref={videoRef}
          className='h-full w-full object-cover'
          muted
          playsInline
          autoPlay
        />
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <div className='h-44 w-44 rounded-md border-2 border-white/80 shadow-lg' />
        </div>

        {/* Status indicators */}
        <div className='absolute top-2 left-2 space-y-1'>
          {permissionStatus === 'denied' && (
            <div className='bg-red-500 text-white px-2 py-1 rounded text-xs font-medium'>
              Camera blocked
            </div>
          )}
          {permissionStatus === 'prompt' && (
            <div className='bg-yellow-500 text-white px-2 py-1 rounded text-xs font-medium'>
              Allow camera
            </div>
          )}
          {devices.length === 0 && permissionStatus !== 'denied' && (
            <div className='bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium'>
              No cameras found
            </div>
          )}
        </div>

        {isStarting && (
          <div className='absolute top-2 right-2 bg-yellow-500 text-white px-2 py-1 rounded text-xs font-medium animate-pulse'>
            Starting...
          </div>
        )}
        {isRunning && !isStarting && (
          <div className='absolute top-2 right-2 bg-green-500 text-white px-2 py-1 rounded text-xs font-medium'>
            Scanning...
          </div>
        )}

        {/* Current mode/device info */}
        <div className='absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/50 text-white px-2 py-1 rounded text-[11px] font-medium backdrop-blur-sm'>
          <span className='opacity-90'>Mode:</span>{' '}
          <span>
            {mode === 'front'
              ? 'Front'
              : mode === 'back-wide'
              ? 'Back (Wide)'
              : 'Back (Main)'}
          </span>
          {currentDeviceLabel && (
            <span className='opacity-90'> · Using: {currentDeviceLabel}</span>
          )}
        </div>
      </div>

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <button
            className='rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={() => start()}
            disabled={isStarting || isRunning}
          >
            {isStarting ? 'Starting...' : 'Start'}
          </button>
          <button
            className='rounded bg-gray-500 px-4 py-2 text-white hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={stop}
            disabled={!isRunning}
          >
            Stop
          </button>
          <button
            className='rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({
                  video: true,
                });
                alert('Camera test successful! Camera is working.');
                stream.getTracks().forEach((track) => track.stop());
              } catch (e: any) {
                alert(`Camera test failed: ${e.message}`);
              }
            }}
            disabled={isStarting || isRunning}
          >
            Test Camera
          </button>
        </div>

        <button
          className='rounded bg-amber-500 px-3 py-2 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
          onClick={toggleTorch}
          disabled={!isRunning || !torchSupported}
          title={
            !isRunning
              ? 'Start camera to use torch'
              : !torchSupported
              ? 'Torch not supported on this device'
              : torchOn
              ? 'Turn torch off'
              : 'Turn torch on'
          }
          aria-label={torchOn ? 'Turn torch off' : 'Turn torch on'}
        >
          {torchOn ? '🔦 Off' : '🔦 On'}
        </button>
      </div>
    </div>
  );
};

export default CodeScanner;
