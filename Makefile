.PHONY: rebuild

# Build, verify, back up, install, and launch a local desktop update.
rebuild:
	node scripts/rebuild-desktop.mjs
