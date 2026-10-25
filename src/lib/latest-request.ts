/**
 * For a component that fetches again whenever a filter changes: only the answer to the LATEST request may change what the component shows.
 *
 * Two requests in flight (a person changes a filter twice in a moment, or a test does) are answered in whatever order the server and the
 * network finish them: without this the slower, older answer arrives last and replaces the newer one, and the list shows the results of
 * a filter that is no longer chosen. `start()` returns the check to make when the answer arrives.
 *
 *   const guard = useRef(createLatestRequestGuard());
 *   async function load() {
 *     const isLatest = guard.current.start();
 *     const data = await fetchSomething(filters);
 *     if (!isLatest()) return; // a newer request has been made: this answer is stale
 *     setRows(data);
 *   }
 */
export function createLatestRequestGuard(): { start(): () => boolean } {
  let latest = 0;
  return {
    start() {
      latest += 1;
      const mine = latest;
      return () => mine === latest;
    },
  };
}
