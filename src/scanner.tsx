import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  type FC,
} from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
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

  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const mountedRef = useRef(true);

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
    readerRef.current = new BrowserMultiFormatReader();

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
      console.error('CodeScanner error:', e);
      onError?.(e);
    },
    [onError]
  );

  const initDevices = useCallback(async () => {
    try {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }

      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));

      if (!mountedRef.current) return;
      setDevices(cams);
      if (cams.length > 0) {
        const back = cams.find((d) => /back|rear|environment/i.test(d.label));
        setSelectedDeviceId(
          (prev) => prev || back?.deviceId || cams[0].deviceId
        );
      }
    } catch (e) {
      handleError(e);
    }
  }, [handleError]);

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
        // Log, but do not stop/restart
        // console.debug('Non-notfound error:', err);
      }
    },
    [onResult]
  );

  const start = useCallback(async () => {
    if (!videoRef.current || !readerRef.current) return;
    if (isStarting || isRunning) return;

    const deviceId = selectedDeviceId;
    if (!deviceId) {
      handleError(new Error('No camera device selected'));
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

      // Force constraints mode with gentle frame rate to avoid flapping
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          frameRate: { ideal: 24, max: 24 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };

      let controls: IScannerControls | null = null;
      try {
        controls = await readerRef.current.decodeFromConstraints(
          constraints,
          videoRef.current,
          onDecode
        );
      } catch (e: any) {
        // Fallback: relax deviceId; prefer environment
        if (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError') {
          controls = await readerRef.current.decodeFromConstraints(
            {
              audio: false,
              video: {
                facingMode: { ideal: 'environment' },
                frameRate: { ideal: 24, max: 24 },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
            },
            videoRef.current,
            onDecode
          );
        } else {
          throw e;
        }
      }

      if (!mountedRef.current) {
        controls?.stop();
        stopActiveStream(videoRef.current);
        return;
      }
      if (!controls) throw new Error('Failed to start scanner');

      controlsRef.current = controls;

      // Ensure the video actually plays
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
        /* might need gesture */
      }

      setIsRunning(true);

      setTimeout(() => {
        if (mountedRef.current) detectTorchSupport();
      }, 300);
    } catch (e) {
      handleError(e);
      if (mountedRef.current) setIsRunning(false);
    } finally {
      if (mountedRef.current) setIsStarting(false);
    }
  }, [
    isStarting,
    isRunning,
    selectedDeviceId,
    handleError,
    detectTorchSupport,
    onDecode,
  ]);

  const stop = useCallback(() => {
    pausedRef.current = true;
    controlsRef.current?.stop();
    controlsRef.current = null;
    stopActiveStream(videoRef.current);
    setIsRunning(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  useEffect(() => {
    if (!selectedDeviceId || !mountedRef.current) return;
    // Delay start slightly to avoid flaps during device enumeration
    const tid = setTimeout(() => start(), 120);
    return () => clearTimeout(tid);
  }, [selectedDeviceId, start]);

  const toggleTorch = useCallback(async () => {
    if (!isRunning || !torchSupported) return;
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track) return;

      const next = !torchOn;
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
              fillLightMode: next ? 'flash' : 'off',
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

  const handleDeviceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newId = e.target.value;
      // Avoid double-binding by stopping first
      if (isRunning || isStarting) {
        controlsRef.current?.stop();
        controlsRef.current = null;
        stopActiveStream(videoRef.current);
        setIsRunning(false);
      }
      setSelectedDeviceId(newId);
    },
    [isRunning, isStarting]
  );

  return (
    <div
      className={`w-full max-w-md mx-auto space-y-3 bg-white rounded-xl shadow p-4 ${className}`}
    >
      <div className='flex items-center gap-2'>
        <label className='text-sm font-medium text-gray-700'>
          Camera source
        </label>
        <select
          className='flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed'
          value={selectedDeviceId}
          onChange={handleDeviceChange}
          disabled={devices.length === 0 || isStarting}
        >
          {devices.length === 0 ? (
            <option>No camera found</option>
          ) : (
            devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))
          )}
        </select>
      </div>

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
        {isRunning && (
          <div className='absolute top-2 right-2 bg-green-500 text-white px-2 py-1 rounded text-xs font-medium'>
            Scanning...
          </div>
        )}
      </div>

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <button
            className='rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={() => start()}
            disabled={isStarting || isRunning || !selectedDeviceId}
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
