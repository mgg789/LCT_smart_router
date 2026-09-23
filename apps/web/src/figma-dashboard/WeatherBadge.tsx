import { useEffect, useState } from 'react';
import { loadDispatchWeather, type DispatchWeather } from '../api/client';
import { TintIcon } from './TintIcon';

const ICONS: Record<DispatchWeather['kind'], string> = {
  clear: '/figma/sun.svg',
  cloud: '/figma/cloud.svg',
  rain: '/figma/cloud-rain.svg',
  snow: '/figma/snowflake.svg',
  storm: '/figma/cloud-storm.svg',
  unknown: '/figma/cloud.svg',
};

const ICON_COLOR: Record<DispatchWeather['kind'], string> = {
  clear: '#272930',
  cloud: '#272930',
  rain: '#ffc72c',
  snow: '#e23b3b',
  storm: '#e23b3b',
  unknown: '#272930',
};

/**
 * Map-corner forecast. A long hover explains that the multiplier is already
 * inside car travel time, plus the temperature and the weather name.
 */
export function WeatherBadge({ token }: { token: string | null }) {
  const [weather, setWeather] = useState<DispatchWeather | null>(null);
  const [hovering, setHovering] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const load = () => {
      void loadDispatchWeather(token)
        .then((next) => {
          if (!cancelled) setWeather(next);
        })
        .catch(() => {
          if (!cancelled) setWeather(null);
        });
    };
    load();
    const timer = window.setInterval(load, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    if (!hovering) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), 700);
    return () => window.clearTimeout(timer);
  }, [hovering]);

  if (!weather) return null;
  const kind = weather.kind;
  const degrees =
    weather.temperatureC === null ? null : `${Math.round(weather.temperatureC)}°`;
  const factor =
    weather.trafficMultiplier > 1
      ? ` Сейчас он ×${String(weather.trafficMultiplier).replace('.', ',')}.`
      : ' Сейчас погода его не поднимает.';

  return (
    <div
      className="absolute right-[16px] top-[16px] z-30"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={() => setHovering(false)}
    >
      <button
        type="button"
        className="flex size-[44px] items-center justify-center rounded-full bg-white shadow-[0_8px_24px_rgba(39,41,48,0.16)]"
        aria-label={degrees ? `${weather.label}, ${degrees}` : weather.label}
      >
        <TintIcon src={ICONS[kind]} color={ICON_COLOR[kind]} size={22} />
      </button>
      {shown ? (
        <p className="absolute right-0 top-[52px] w-[240px] rounded-[16px] bg-white px-[14px] py-[12px] text-[14px] leading-[1.35] text-figma-ink shadow-[0_12px_32px_rgba(39,41,48,0.18)]">
          {weather.label}
          {degrees ? `, ${degrees}` : ''}. Погодный коэффициент учитывается при расчёте времени в
          пути.{factor}
        </p>
      ) : null}
    </div>
  );
}
