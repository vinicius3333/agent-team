# Marketing tab generation prompts

Generated with the built-in image generation tool (Codex, `gpt-6-astra`). The input image was `docs/screenshots/03-project-running.png`, used as the style reference. The final PNG is resized to 1440×900.

## Light

Use your image generation tool to draw ONE high-fidelity desktop UI mockup (16:10, 1440x900 style).

Context: the attached image is the existing "agent-team" dashboard (a project page with tabs: Overview, Lead, Office, Docs, Branding, Marketing, QA, Agent calls, System, Config). Keep exactly its visual style: same header, same tab bar, same cards, colors, typography (shadcn/ui look, neutral grays, rounded cards, subtle borders).

Draw the new "Marketing" tab selected. Its content:
- A top card: "Marketing pieces" title, small muted line "3 pieces · 4 formats · language pt-BR", and a segmented filter "All / Open Graph 1200×630 / Square 1080×1080 / Story 1080×1920 / X 1600×900".
- Below, one card per piece (show 2 fully, the 3rd peeking). Each piece card: left column with the piece name "Launch", a badge "Stock photo · Openverse" or "Generated", the headline in bold, the subtitle, the CTA text, the problem statement in muted small text, and a credit line "Photo by … · CC BY". Right side: a row of thumbnails of the rendered ad images in their real aspect ratios (wide, square, tall story, wide), each with a small caption and a download icon button.
- The ad images themselves: photos of a busy clinic waiting room / paper calendar with overlaid bold headline text and a colored CTA button and a small logo.
- A "Download all" outline button in the top card.
Realistic product screenshot, not a device photo. No real brand logos.
