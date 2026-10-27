// The version of the messages between a page and the doc host: the calls,
// their answers and the events (web/api.js, desktop/doc-host.js). A
// teammate's page comes from the relay, built from main, and the doc host
// from the app its owner installed, so the two can be apart. A change that
// a page or host on the version before would misread raises it; the host
// says its own in `hello`, and a page told another one says which side to
// update. A host that says none is at 1.
export const PROTOCOL = 1;
