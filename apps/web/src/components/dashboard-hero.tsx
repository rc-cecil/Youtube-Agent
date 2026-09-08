import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Pause, Play, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The supplied 3D animation is decorative. Playback never blocks workspace actions. */
export function DashboardHero() {
  const video = useRef<HTMLVideoElement>(null);
  const region = useRef<HTMLElement>(null);
  const requested = useRef(false);
  const visible = useRef(true);
  const [playing, setPlaying] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = video.current;
    const container = region.current;
    if (!element || !container) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;
    const sync = () => {
      if (requested.current && visible.current && !document.hidden) {
        if (!element.getAttribute('src')) element.src = '/media/gameplay-studio.mp4';
        void element.play().catch(() => setPlaying(false));
      } else {
        element.pause();
      }
    };
    const setPreference = () => {
      requested.current = !preference.matches && !connection?.saveData;
      sync();
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible.current = Boolean(entry?.isIntersecting);
        sync();
      },
      { threshold: 0.15 },
    );
    observer.observe(container);
    preference.addEventListener('change', setPreference);
    document.addEventListener('visibilitychange', sync);
    setPreference();
    return () => {
      observer.disconnect();
      preference.removeEventListener('change', setPreference);
      document.removeEventListener('visibilitychange', sync);
      element.pause();
    };
  }, []);

  const toggle = () => {
    const element = video.current;
    if (!element) return;
    requested.current = element.paused;
    if (requested.current) {
      if (!element.getAttribute('src')) element.src = '/media/gameplay-studio.mp4';
      void element.play().catch(() => setPlaying(false));
    } else element.pause();
  };

  return (
    <section className="studio-hero" ref={region} aria-labelledby="hero-title">
      <div className="hero-media">
        <video
          ref={video}
          width={1280}
          height={720}
          poster="/media/gameplay-studio-poster.jpg"
          muted
          loop
          playsInline
          preload="none"
          aria-hidden="true"
          tabIndex={-1}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            setUnavailable(true);
            setPlaying(false);
          }}
        />
      </div>
      <div className="hero-copy">
        <h2 id="hero-title">
          You play.
          <br />
          Make it <em>worth keeping.</em>
        </h2>
        <p>
          Give your best sessions a home. Upload, validate, and organize your original gameplay.
        </p>
        <div className="hero-actions">
          <Button asChild size="lg">
            <Link to="/uploads">
              <Plus data-icon="inline-start" />
              Upload gameplay
            </Link>
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link to="/library">
              Explore library
              <ArrowUpRight data-icon="inline-end" />
            </Link>
          </Button>
        </div>
        <span className="hero-footnote">Your originals stay original. Always.</span>
      </div>
      <div className="hero-media-caption">
        <span>Built around your gameplay</span>
        <Button
          variant="secondary"
          size="icon"
          disabled={unavailable}
          onClick={toggle}
          aria-label={
            unavailable
              ? 'Hero animation unavailable'
              : playing
                ? 'Pause hero animation'
                : 'Play hero animation'
          }
          aria-pressed={playing}
        >
          <span className="t-icon-swap" data-state={playing ? 'b' : 'a'} aria-hidden="true">
            <Play className="t-icon" data-icon="a" />
            <Pause className="t-icon" data-icon="b" />
          </span>
        </Button>
      </div>
    </section>
  );
}
