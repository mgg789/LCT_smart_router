import { Observable } from 'rxjs';

/**
 * Adapts an async generator to an RxJS `Observable`, since `@Sse()` needs one.
 *
 * The teardown matters as much as the emission: when the browser disconnects, Nest
 * unsubscribes, and without `source.return()` the generator would stay parked on its
 * `await` forever, holding its subscription and its queue for the lifetime of the
 * process. Every long-lived stream in this API goes through here for exactly that reason.
 */
export function fromAsync<T>(source: AsyncGenerator<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    let cancelled = false;
    void (async () => {
      try {
        for await (const value of source) {
          if (cancelled) {
            return;
          }
          subscriber.next(value);
        }
        subscriber.complete();
      } catch (error) {
        subscriber.error(error);
      }
    })();
    return () => {
      cancelled = true;
      void source.return?.(undefined);
    };
  });
}
