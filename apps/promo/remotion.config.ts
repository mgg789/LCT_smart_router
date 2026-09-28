import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setCodec('h264');
Config.setCrf(15);
Config.setOverwriteOutput(true);
// The reel is one continuous piece of screen footage; a windowless Chrome without GPU
// rasterisation renders the same on every machine that builds it.
Config.setChromiumOpenGlRenderer('angle');
Config.setDelayRenderTimeoutInMilliseconds(120_000);
