# Sources and reconstruction

This revision replaces the earlier generic logo-on-fin illustrations with tail-specific livery compositions. Each file's source and method are in `manifest.json`.

## Complete vector-tail sources

17 tails use [abbyfour/airline-tails](https://github.com/abbyfour/airline-tails). Their existing fin geometry, livery placement and proportions are retained. Alpha-mask silhouettes were made white to preserve opaque clipping consistently across SVG renderers. Avianca's pale red opacity was corrected against a photograph and the small flag changed to Colombia for AV mainline. Original source license: `licenses/airline-tails-Apache-2.0.txt`. As that repository states, its license does not relicense third-party airline logos.

EVA Air uses the complete [Soaring Symbols EVA tail](https://github.com/soaring-symbols/soaring-symbols/blob/main/assets/eva-air/tail.svg), with the original globe/livery arrangement. Source license: `licenses/soaring-symbols-MIT.txt`.

## Artwork-derived vectors

Singapore Airlines, Asiana Airlines, Shenzhen Airlines and Thai Airways were vector-traced from the tail artwork on page 20 of [Melbourne Airport's November 2025 plane-spotting booklet](https://assets-au-01.kc-usercontent.com/be08d7b0-97a1-02f9-2be6-a0c139c3c337/41021ed9-5d38-40d8-94a1-c5e3b64f5a10/Plane_Spotting_booklet_Nov_2025-PRESS.pdf). The original embedded artwork was about 260 × 188 pixels per tail. The reconstruction retains the livery boundaries and insignia orientation; these are traced vectors, not the airlines' original vector masters.

Copa was vector-traced from [Plane Sticker's Copa tail illustration](https://planesticker.com/collections/copa-airlines), preserving the white and gold sweeping lines. EGYPTAIR was vector-traced from the tail illustration published by [aeroTELEGRAPH](https://www.aerotelegraph.com/ticker/egypt-air-laesst-zweiten-airbus-a330-in-dresden-zum-frachter-umruesten/rkj7g96), retaining the full blue fan and Horus layout.

## Photograph-referenced vectors

Croatia Airlines' A220 tail follows the spaced red, dark blue and light blue squares in [its official picture gallery](https://www.croatiaairlines.com/Media/Picture-gallery/). South African Airways follows the gold sun and flag layout visible in [AeroTime's tail photograph](https://www.aerotime.aero/articles/south-african-airways-suspends-acting-ceo-after-four-months). These are newly drawn illustrations based on the visible aircraft-tail geometry and paint layout.

## Identity and rights

Airline names, logos and liveries remain the property of their respective airlines. Published source illustrations and photographs remain credited to their publishers/rightsholders. Inclusion and technical conversion do not imply endorsement or a transfer of rights. Keep this attribution file with the pack; the repository code licenses apply only within their stated scope.

## Membership references

- [Singapore Airlines — Star Alliance](https://www.singaporeair.com/en_UK/se/plan-travel/partner-airlines/star-alliance/).
- [ANA — Asiana's departure from Star Alliance](https://www.anahd.co.jp/group/en/pr/202606/20260625.html).

Membership snapshot: 15 November 2026.

## Version 3 orientation

Asiana (OZ), Copa (CM), EVA (BR), Shenzhen (ZH), Singapore (SQ), South African (SA), and Thai (TG) were horizontally reflected to match Air New Zealand’s tail direction. Existing tail geometry and color regions were retained. All other assets kept their existing orientation.

## Version 4 EgyptAir correction

EgyptAir (MS) retains the reference-traced Horus emblem and blue fan livery. The art is fitted to the common component fin silhouette; the long dorsal root extension, sloping baseline and traced edge artifacts are removed. This is a representative interface illustration, not an aircraft paint diagram. The other 25 airline assets are unchanged from version 3.
