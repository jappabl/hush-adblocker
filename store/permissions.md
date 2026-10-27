# Chrome Web Store: privacy practices tab

## Single purpose
Hush blocks ads, trackers, malware sites and unwanted redirects/pop-up tabs on web pages.

## Permission justifications
- **declarativeNetRequest**: blocks ad, tracker and malware requests using filter-list rules.
- **webRequest**: observes (never blocks or changes) which requests were blocked in each tab, to show the per-page count on the toolbar badge and in the popup.
- **scripting**: registers the page scripts that hide ad slots, stop click-hijacking redirects/pop-ups and remove YouTube ads, and inserts site-specific hiding CSS.
- **webNavigation**: detects new tabs a page opens and closes them when they go to known pop-under ad networks; detects when a page redirects itself to such networks.
- **storage**: saves per-site on/off settings, the updated filter lists, and per-tab blocked counts, locally.
- **alarms**: refreshes the filter lists every 12 hours.
- **Host permission (all sites)**: ads, trackers and click hijacking happen on any site; blocking them requires running on every page the user visits.

## Remote code
No. Hush does not load or run remote code. It downloads filter lists (data: lists of domains and CSS selectors) and compiles them into blocking rules locally.

## Data usage
Hush does not collect or transmit any user data. (Check: none of the data categories.) Certifications: does not sell data, does not use or transfer data for unrelated purposes, does not use data for creditworthiness or lending.
