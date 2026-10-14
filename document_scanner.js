(function () {
  'use strict';

  var scannerGlobal = typeof window !== 'undefined' ? window : globalThis;

  var active = false;
  var ANALYSIS_LONG_SIDE = 360;
  var STABLE_FRAMES_REQUIRED = 8;
  var ANALYSIS_INTERVAL_MS = 140;

  function polygonArea(points) {
    var sum = 0;
    for (var index = 0; index < points.length; index += 1) {
      var current = points[index];
      var next = points[(index + 1) % points.length];
      sum += current.x * next.y - next.x * current.y;
    }
    return Math.abs(sum) / 2;
  }

  function distance(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function validQuad(points, width, height) {
    if (!points || points.length !== 4) return false;
    var minDistance = Math.min(width, height) * 0.08;
    for (var index = 0; index < points.length; index += 1) {
      if (distance(points[index], points[(index + 1) % 4]) < minDistance) {
        return false;
      }
    }
    var sign = 0;
    for (var corner = 0; corner < points.length; corner += 1) {
      var a = points[corner];
      var b = points[(corner + 1) % 4];
      var c = points[(corner + 2) % 4];
      var cross = (b.x - a.x) * (c.y - b.y) -
        (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1) return false;
      if (sign === 0) sign = Math.sign(cross);
      if (Math.sign(cross) !== sign) return false;
    }
    var fraction = polygonArea(points) / (width * height);
    return fraction >= 0.13 && fraction <= 0.97;
  }

  function quadFromComponent(mask, width, height, options) {
    var visited = new Uint8Array(mask.length);
    var queue = new Int32Array(mask.length);
    var best = null;
    var minimumPixels = Math.max(80, Math.round(mask.length * options.minPixels));

    for (var start = 0; start < mask.length; start += 1) {
      if (!mask[start] || visited[start]) continue;
      var head = 0;
      var tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      var count = 0;
      var minX = width;
      var minY = height;
      var maxX = 0;
      var maxY = 0;
      var topLeft = null;
      var topRight = null;
      var bottomRight = null;
      var bottomLeft = null;
      var minSum = Infinity;
      var maxSum = -Infinity;
      var minDiff = Infinity;
      var maxDiff = -Infinity;

      while (head < tail) {
        var offset = queue[head++];
        var y = Math.floor(offset / width);
        var x = offset - y * width;
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        var sum = x + y;
        var diff = x - y;
        if (sum < minSum) {
          minSum = sum;
          topLeft = { x: x, y: y };
        }
        if (sum > maxSum) {
          maxSum = sum;
          bottomRight = { x: x, y: y };
        }
        if (diff > maxDiff) {
          maxDiff = diff;
          topRight = { x: x, y: y };
        }
        if (diff < minDiff) {
          minDiff = diff;
          bottomLeft = { x: x, y: y };
        }

        if (x > 0) {
          var left = offset - 1;
          if (mask[left] && !visited[left]) {
            visited[left] = 1;
            queue[tail++] = left;
          }
        }
        if (x + 1 < width) {
          var right = offset + 1;
          if (mask[right] && !visited[right]) {
            visited[right] = 1;
            queue[tail++] = right;
          }
        }
        if (y > 0) {
          var above = offset - width;
          if (mask[above] && !visited[above]) {
            visited[above] = 1;
            queue[tail++] = above;
          }
        }
        if (y + 1 < height) {
          var below = offset + width;
          if (mask[below] && !visited[below]) {
            visited[below] = 1;
            queue[tail++] = below;
          }
        }
      }

      if (count < minimumPixels) continue;
      var boxFraction = ((maxX - minX + 1) * (maxY - minY + 1)) /
        (width * height);
      if (boxFraction < options.minArea || boxFraction > options.maxArea) {
        continue;
      }
      var points = [topLeft, topRight, bottomRight, bottomLeft];
      if (!validQuad(points, width, height)) continue;
      var area = polygonArea(points);
      var fill = count / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
      var score = area * (options.areaWeight + Math.min(fill, 0.8));
      if (!best || score > best.score) {
        best = { points: points, score: score, area: area };
      }
    }
    return best;
  }

  function closeMask(mask, width, height) {
    var dilated = new Uint8Array(mask.length);
    for (var y = 1; y < height - 1; y += 1) {
      for (var x = 1; x < width - 1; x += 1) {
        var offset = y * width + x;
        if (!mask[offset]) continue;
        for (var dy = -1; dy <= 1; dy += 1) {
          for (var dx = -1; dx <= 1; dx += 1) {
            dilated[offset + dy * width + dx] = 1;
          }
        }
      }
    }
    var closed = new Uint8Array(mask.length);
    for (var row = 1; row < height - 1; row += 1) {
      for (var column = 1; column < width - 1; column += 1) {
        var current = row * width + column;
        var keep = true;
        for (var sy = -1; sy <= 1 && keep; sy += 1) {
          for (var sx = -1; sx <= 1; sx += 1) {
            if (!dilated[current + sy * width + sx]) {
              keep = false;
              break;
            }
          }
        }
        if (keep) closed[current] = 1;
      }
    }
    return closed;
  }

  function otsuThreshold(gray) {
    var histogram = new Uint32Array(256);
    var total = gray.length;
    var sum = 0;
    for (var index = 0; index < total; index += 1) {
      var value = gray[index];
      histogram[value] += 1;
      sum += value;
    }
    var backgroundWeight = 0;
    var backgroundSum = 0;
    var bestVariance = -1;
    var bestThreshold = 128;
    for (var threshold = 0; threshold < 256; threshold += 1) {
      backgroundWeight += histogram[threshold];
      if (backgroundWeight === 0) continue;
      var foregroundWeight = total - backgroundWeight;
      if (foregroundWeight === 0) break;
      backgroundSum += threshold * histogram[threshold];
      var backgroundMean = backgroundSum / backgroundWeight;
      var foregroundMean = (sum - backgroundSum) / foregroundWeight;
      var delta = backgroundMean - foregroundMean;
      var variance = backgroundWeight * foregroundWeight * delta * delta;
      if (variance > bestVariance) {
        bestVariance = variance;
        bestThreshold = threshold;
      }
    }
    return bestThreshold;
  }

  function detectDocumentQuad(rgba, width, height) {
    if (!rgba || width < 40 || height < 40) return null;
    var pixelCount = width * height;
    var gray = new Uint8Array(pixelCount);
    var luminanceSum = 0;
    for (var index = 0; index < pixelCount; index += 1) {
      var source = index * 4;
      var value = (rgba[source] * 77 + rgba[source + 1] * 150 +
        rgba[source + 2] * 29) >> 8;
      gray[index] = value;
      luminanceSum += value;
    }

    // Most catalog cards are lighter than the desk/background. Otsu gives a
    // stable foreground mask without any external computer-vision library.
    var threshold = otsuThreshold(gray);
    var meanLuminance = luminanceSum / pixelCount;
    var brightMask = new Uint8Array(pixelCount);
    var brightCutoff = Math.max(threshold, Math.min(225, meanLuminance + 8));
    for (var brightIndex = 0; brightIndex < pixelCount; brightIndex += 1) {
      if (gray[brightIndex] >= brightCutoff) brightMask[brightIndex] = 1;
    }
    var brightCandidate = quadFromComponent(
      closeMask(brightMask, width, height),
      width,
      height,
      { minPixels: 0.035, minArea: 0.14, maxArea: 0.96, areaWeight: 1.4 }
    );

    // Edge fallback covers coloured or low-contrast cards.
    var gradients = new Uint16Array(pixelCount);
    var gradientSum = 0;
    var gradientSquaredSum = 0;
    var gradientCount = 0;
    for (var y = 1; y < height - 1; y += 1) {
      for (var x = 1; x < width - 1; x += 1) {
        var offset = y * width + x;
        var gx = -gray[offset - width - 1] + gray[offset - width + 1] -
          2 * gray[offset - 1] + 2 * gray[offset + 1] -
          gray[offset + width - 1] + gray[offset + width + 1];
        var gy = -gray[offset - width - 1] - 2 * gray[offset - width] -
          gray[offset - width + 1] + gray[offset + width - 1] +
          2 * gray[offset + width] + gray[offset + width + 1];
        var magnitude = Math.abs(gx) + Math.abs(gy);
        gradients[offset] = magnitude;
        gradientSum += magnitude;
        gradientSquaredSum += magnitude * magnitude;
        gradientCount += 1;
      }
    }
    var gradientMean = gradientSum / Math.max(1, gradientCount);
    var gradientVariance = gradientSquaredSum / Math.max(1, gradientCount) -
      gradientMean * gradientMean;
    var gradientDeviation = Math.sqrt(Math.max(0, gradientVariance));
    var edgeThreshold = Math.max(90, gradientMean + gradientDeviation * 1.15);
    var edgeMask = new Uint8Array(pixelCount);
    for (var edgeIndex = 0; edgeIndex < pixelCount; edgeIndex += 1) {
      if (gradients[edgeIndex] >= edgeThreshold) edgeMask[edgeIndex] = 1;
    }
    var edgeCandidate = quadFromComponent(
      closeMask(closeMask(edgeMask, width, height), width, height),
      width,
      height,
      { minPixels: 0.004, minArea: 0.13, maxArea: 0.97, areaWeight: 0.8 }
    );

    var selected = null;
    if (brightCandidate && edgeCandidate) {
      selected = brightCandidate.score >= edgeCandidate.score
        ? brightCandidate
        : edgeCandidate;
    } else {
      selected = brightCandidate || edgeCandidate;
    }
    if (!selected) return null;
    return {
      points: selected.points,
      sharpness: gradientMean,
      areaFraction: selected.area / pixelCount,
    };
  }

  function smoothQuad(previous, next) {
    if (!previous) return next.map(function (point) {
      return { x: point.x, y: point.y };
    });
    return next.map(function (point, index) {
      return {
        x: previous[index].x * 0.62 + point.x * 0.38,
        y: previous[index].y * 0.62 + point.y * 0.38,
      };
    });
  }

  function quadMotion(previous, next, width, height) {
    if (!previous) return Infinity;
    var diagonal = Math.sqrt(width * width + height * height);
    var total = 0;
    for (var index = 0; index < 4; index += 1) {
      total += distance(previous[index], next[index]) / diagonal;
    }
    return total / 4;
  }

  function defaultQuad(width, height) {
    return [
      { x: width * 0.08, y: height * 0.12 },
      { x: width * 0.92, y: height * 0.12 },
      { x: width * 0.92, y: height * 0.88 },
      { x: width * 0.08, y: height * 0.88 },
    ];
  }

  function normalizedQuad(points, width, height) {
    function point(value) {
      return {
        x: Math.max(0, Math.min(1, value.x / width)),
        y: Math.max(0, Math.min(1, value.y / height)),
      };
    }
    return {
      top_left: point(points[0]),
      top_right: point(points[1]),
      bottom_right: point(points[2]),
      bottom_left: point(points[3]),
    };
  }

  function scannerStyles() {
    return [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'background:#050607', 'color:white', 'font-family:Roboto,Arial,sans-serif',
      'display:flex', 'flex-direction:column', 'align-items:stretch',
      'overscroll-behavior:none', 'touch-action:none'
    ].join(';');
  }

  function buttonStyle(extra) {
    return [
      'border:1px solid rgba(255,255,255,.62)', 'background:rgba(12,15,18,.72)',
      'color:white', 'border-radius:999px', 'min-height:46px', 'padding:0 18px',
      'font-size:15px', 'font-weight:700', 'backdrop-filter:blur(8px)', extra || ''
    ].join(';');
  }

  function cameraFrameRect(width, height, aspectRatio, scale) {
    aspectRatio = Number.isFinite(aspectRatio) ? Math.max(0.25, Math.min(4, aspectRatio)) : 15 / 9;
    scale = Number.isFinite(scale) ? Math.max(0.2, Math.min(1, scale)) : 0.85;
    var frameWidth = width * scale;
    var frameHeight = frameWidth / aspectRatio;
    if (frameHeight > height * scale) {
      frameHeight = height * scale;
      frameWidth = frameHeight * aspectRatio;
    }
    frameWidth = Math.max(1, Math.floor(frameWidth));
    frameHeight = Math.max(1, Math.floor(frameHeight));
    return { x: Math.floor((width - frameWidth) / 2), y: Math.floor((height - frameHeight) / 2), width: frameWidth, height: frameHeight };
  }

  function isDesktopBrowser() {
    var agent = navigator.userAgent || '';
    if (!agent) return false;
    var mobile = /Android|iPhone|iPad|iPod/i.test(agent);
    var iPadDesktopAgent = /Macintosh/i.test(agent) && navigator.maxTouchPoints > 1;
    return !mobile && !iPadDesktopAgent;
  }

  scannerGlobal.appWebDocumentScanner = function (languageCode, compactUi, manualCapture, imageQuality, desktopFrame, frameAspectRatio, frameScale) {
    compactUi = compactUi === true;
    // Старый Dart-клиент может ещё передавать только первые четыре аргумента.
    desktopFrame = desktopFrame === true || isDesktopBrowser();
    if (desktopFrame) manualCapture = true;
    manualCapture = manualCapture === true;
    imageQuality = typeof imageQuality === 'number' ? Math.max(1, Math.min(100, imageQuality)) / 100 : 0.96;
    var labels = languageCode === 'ky' ? {
      busy: 'Сканер мурунтан эле ачык',
      cancel: 'Жокко чыгаруу',
      close: 'Сканерди жабуу',
      title: 'Карточканы скандоо',
      point: 'Камераны карточкага багыттаңыз',
      shutter: 'Азыр тартуу',
      ready: 'Сүрөт даяр',
      failed: 'Сүрөттү даярдоо мүмкүн болгон жок',
      wholeCard: 'Карточканы толугу менен кадрга жайгаштырыңыз',
      hold: 'Алкак табылды — телефонду кыймылдатпаңыз',
      capturing: 'Автоматтык түрдө тартып жатам…',
      unsupported: 'Бул браузер камераны колдобойт',
      permission: 'Браузерге камераны колдонууга уруксат бериңиз',
      openFailed: 'Камераны ачуу мүмкүн болгон жок. Башка колдонмолорду текшериңиз.',
      chooseCamera: 'Камераны тандоо', refreshCameras: 'Камералардын тизмесин жаңыртуу',
      defaultCamera: 'Демейки камера', unnamedCamera: 'Камера',
      disconnected: 'Камера ажыратылды. Башка камераны тандаңыз.',
      savedMissing: 'Мурун тандалган камера жок. Демейки камера ачылды.',
    } : {
      busy: 'Сканер уже открыт',
      cancel: 'Отмена',
      close: 'Закрыть сканер',
      title: 'Сканирование карточки',
      point: 'Наведите камеру на карточку',
      shutter: 'Снять сейчас',
      ready: 'Снимок готов',
      failed: 'Не удалось подготовить снимок',
      wholeCard: 'Наведите камеру на всю карточку',
      hold: 'Рамка найдена — держите телефон неподвижно',
      capturing: 'Снимаю автоматически…',
      unsupported: 'Этот браузер не поддерживает доступ к камере',
      permission: 'Разрешите браузеру использовать камеру',
      openFailed: 'Не удалось открыть камеру. Проверьте, не занята ли она другим приложением.',
      chooseCamera: 'Выбор камеры', refreshCameras: 'Обновить список камер',
      defaultCamera: 'Камера по умолчанию', unnamedCamera: 'Камера',
      disconnected: 'Камера отключена. Выберите другую камеру.',
      savedMissing: 'Ранее выбранная камера недоступна. Открыта камера по умолчанию.',
    };
    if (active) {
      return Promise.resolve(JSON.stringify({
        error: 'busy',
        message: labels.busy,
      }));
    }
    active = true;

    return new Promise(function (resolve) {
      var stream = null;
      var animationFrame = 0;
      var settled = false;
      var lastAnalysisAt = 0;
      var stableFrames = 0;
      var previousRawQuad = null;
      var displayedQuad = null;
      var analysisWidth = 0;
      var analysisHeight = 0;
      var stageResizeObserver = null;
      var cameraGeneration = 0;
      var cancelVideoWait = null;
      var deviceListGeneration = 0;
      var activeDeviceId = '';
      var cameraSelect = null;
      var refreshCameras = null;
      var mediaDevices = navigator.mediaDevices;
      var selectionKey = 'bookScanner.desktopCameraDeviceId';
      var rememberedDeviceId = '';
      try { rememberedDeviceId = desktopFrame ? scannerGlobal.localStorage.getItem(selectionKey) || '' : ''; } catch (_) {}

      var root = document.createElement('div');
      root.id = 'app-web-document-scanner';
      root.setAttribute('data-camera-mode', desktopFrame ? 'desktop-frame' : 'mobile');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.style.cssText = scannerStyles();

      var header = document.createElement('div');
      header.style.cssText = [
        'display:flex', 'align-items:center', 'justify-content:space-between',
        'padding:calc(10px + env(safe-area-inset-top)) 12px 10px', 'gap:12px',
        'position:relative', 'z-index:2'
      ].join(';');
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = labels.cancel;
      cancel.setAttribute('aria-label', labels.close);
      cancel.style.cssText = buttonStyle('');
      var title = document.createElement('div');
      title.textContent = labels.title;
      title.style.cssText = 'font-size:17px;font-weight:800;text-align:right';
      header.append(cancel, title);

      var viewport = document.createElement('div');
      viewport.style.cssText = [
        'position:relative', 'flex:1 1 auto', 'min-height:0', 'align-self:center',
        'width:100%', 'max-width:100vw', 'display:flex', 'align-items:center',
        'justify-content:center', 'overflow:hidden'
      ].join(';');
      var stage = document.createElement('div');
      // Safari не должен запускать поток в видеоблоке нулевого размера.
      stage.style.cssText = 'position:relative;width:100%;height:100%;max-width:100%;max-height:100%;overflow:hidden';
      var video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.setAttribute('autoplay', '');
      video.setAttribute('muted', '');
      video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:black';
      var overlay = document.createElement('canvas');
      overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
      stage.append(video, overlay);
      var frameGuide = null;
      if (desktopFrame) {
        frameGuide = document.createElement('div');
        frameGuide.id = 'app-web-camera-frame';
        frameGuide.setAttribute('role', 'img');
        frameGuide.setAttribute('aria-label', languageCode === 'ky' ? 'Карточканын алкагы' : 'Рамка карточки');
        frameGuide.style.cssText = [
          'position:absolute', 'box-sizing:border-box', 'pointer-events:none',
          'border:3px solid #65d98b', 'border-radius:4px', 'z-index:2',
          'box-shadow:0 0 0 200vmax rgba(0,0,0,.42)', 'display:none'
        ].join(';');
        stage.append(frameGuide);
      }
      viewport.append(stage);

      var footer = document.createElement('div');
      footer.style.cssText = [
        'padding:12px 16px calc(14px + env(safe-area-inset-bottom))',
        'display:flex', 'align-items:center', 'gap:12px', 'background:#050607'
      ].join(';');
      var messageWrap = document.createElement('div');
      messageWrap.style.cssText = 'flex:1;min-width:0';
      var message = document.createElement('div');
      message.textContent = labels.point;
      message.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:7px';
      var progressTrack = document.createElement('div');
      progressTrack.style.cssText = 'height:4px;border-radius:4px;background:rgba(255,255,255,.2);overflow:hidden';
      var progress = document.createElement('div');
      progress.style.cssText = 'height:100%;width:0;background:#65d98b;transition:width 120ms linear';
      progressTrack.append(progress);
      messageWrap.append(message, progressTrack);
      var shutter = document.createElement('button');
      shutter.type = 'button';
      shutter.disabled = true;
      shutter.textContent = labels.shutter;
      shutter.style.cssText = buttonStyle('white-space:nowrap');
      footer.append(messageWrap, shutter);
      if (compactUi) {
        cancel.textContent = '×';
        cancel.style.cssText = buttonStyle([
          'position:absolute', 'top:calc(12px + env(safe-area-inset-top))',
          'left:12px', 'z-index:3', 'width:46px', 'min-height:46px',
          'padding:0', 'font-size:30px', 'line-height:1'
        ].join(';'));
        shutter.textContent = '';
        shutter.setAttribute('aria-label', labels.shutter);
        shutter.style.cssText = [
          'position:absolute', 'left:50%',
          'bottom:calc(18px + env(safe-area-inset-bottom))',
          'transform:translateX(-50%)', 'z-index:3', 'width:68px',
          'height:68px', 'padding:0', 'border-radius:50%',
          'border:5px solid white', 'background:rgba(255,255,255,.25)',
          'box-shadow:0 0 0 2px rgba(0,0,0,.32)'
        ].join(';');
        root.append(viewport, cancel, shutter);
      } else {
        root.append(header, viewport, footer);
      }

      if (desktopFrame && mediaDevices && mediaDevices.enumerateDevices) {
        var cameraBar = document.createElement('div');
        cameraBar.style.cssText = compactUi
          ? 'position:absolute;top:calc(12px + env(safe-area-inset-top));left:72px;right:12px;z-index:4;display:flex;gap:8px'
          : 'display:flex;gap:8px;padding:0 12px 8px;flex:none';
        cameraSelect = document.createElement('select');
        cameraSelect.id = 'app-web-camera-select';
        cameraSelect.setAttribute('aria-label', labels.chooseCamera);
        cameraSelect.style.cssText = 'flex:1;min-width:0;max-width:360px;min-height:48px;font:inherit;font-size:16px;padding:0 10px;color:white;background:#17211f;border:1px solid #65d98b;border-radius:8px';
        cameraSelect.disabled = true;
        var initialOption = document.createElement('option');
        initialOption.value = ''; initialOption.textContent = labels.defaultCamera;
        cameraSelect.append(initialOption);
        refreshCameras = document.createElement('button');
        refreshCameras.type = 'button';
        refreshCameras.textContent = '↻';
        refreshCameras.setAttribute('aria-label', labels.refreshCameras);
        refreshCameras.style.cssText = buttonStyle('min-width:48px;min-height:48px;padding:0;font-size:24px');
        refreshCameras.addEventListener('click', function () {
          updateCameraList().then(function () {
            if (!settled && !stream) openCamera(cameraSelect.value, false);
          });
        });
        cameraSelect.addEventListener('change', function () {
          openCamera(cameraSelect.value, false);
        });
        cameraBar.append(cameraSelect, refreshCameras);
        if (compactUi) {
          cameraBar.style.flexWrap = 'wrap';
          message.style.cssText = 'flex-basis:100%;display:none;font-size:14px;line-height:1.4;background:#17211f;padding:6px;box-sizing:border-box';
          message.setAttribute('role', 'status');
          cameraBar.append(message);
        }
        if (compactUi) root.append(cameraBar);
        else root.insertBefore(cameraBar, viewport);
        if (mediaDevices.addEventListener) mediaDevices.addEventListener('devicechange', onDeviceChange);
      }

      var analysis = document.createElement('canvas');
      var analysisContext = analysis.getContext('2d', { willReadFrequently: true });
      var overlayContext = overlay.getContext('2d');

      function cleanup() {
        if (cancelVideoWait) cancelVideoWait();
        cameraGeneration += 1;
        deviceListGeneration += 1;
        if (mediaDevices && mediaDevices.removeEventListener) mediaDevices.removeEventListener('devicechange', onDeviceChange);
        if (animationFrame) cancelAnimationFrame(animationFrame);
        stopCurrentStream();
        root.remove();
        document.removeEventListener('keydown', onKeyDown);
        scannerGlobal.removeEventListener('pagehide', onPageHide);
        scannerGlobal.removeEventListener('resize', fitStage);
        if (stageResizeObserver) stageResizeObserver.disconnect();
        active = false;
      }

      function finish(value) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      }

      function finishError(code, text) {
        finish(JSON.stringify({ error: code, message: text }));
      }

      function waitForVideoFrame(generation) {
        return new Promise(function (resolve, reject) {
          var frame = 0, timer = 0, done = false;
          function complete(error) {
            if (done) return;
            done = true;
            if (frame) cancelAnimationFrame(frame);
            if (timer) scannerGlobal.clearTimeout(timer);
            if (cancelVideoWait === cancel) cancelVideoWait = null;
            if (error) reject(error); else resolve();
          }
          function cancel() { complete(); }
          function check() {
            if (settled || generation !== cameraGeneration) { complete(); return; }
            if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
              complete();
              return;
            }
            frame = requestAnimationFrame(check);
          }
          cancelVideoWait = cancel;
          check();
          // Ограничение по времени работает и при остановленном rAF.
          if (!done) timer = scannerGlobal.setTimeout(function () {
            complete(new Error('camera_frame_timeout'));
          }, 10000);
        });
      }

      function fitStage() {
        if (!video.videoWidth || !video.videoHeight || !viewport.clientWidth || !viewport.clientHeight) return;
        // Видео и маска занимают один прямоугольник без внутренних чёрных полос.
        var ratio = video.videoWidth / video.videoHeight;
        var width = Math.min(viewport.clientWidth, viewport.clientHeight * ratio);
        stage.style.width = width + 'px';
        stage.style.height = width / ratio + 'px';
      }

      function drawOverlay(points, ready) {
        if (!overlayContext) return;
        var overlayWidth = overlay.width;
        var overlayHeight = overlay.height;
        overlayContext.clearRect(0, 0, overlayWidth, overlayHeight);
        if (!points) return;
        overlayContext.save();
        overlayContext.fillStyle = 'rgba(0,0,0,.42)';
        overlayContext.beginPath();
        overlayContext.rect(0, 0, overlayWidth, overlayHeight);
        overlayContext.moveTo(points[0].x, points[0].y);
        for (var index = 1; index < points.length; index += 1) {
          overlayContext.lineTo(points[index].x, points[index].y);
        }
        overlayContext.closePath();
        overlayContext.fill('evenodd');
        overlayContext.strokeStyle = ready ? '#65d98b' : '#ffd166';
        overlayContext.lineWidth = Math.max(2, overlayWidth / (desktopFrame ? 400 : 120));
        overlayContext.lineJoin = 'round';
        overlayContext.beginPath();
        overlayContext.moveTo(points[0].x, points[0].y);
        for (var pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
          overlayContext.lineTo(points[pointIndex].x, points[pointIndex].y);
        }
        overlayContext.closePath();
        overlayContext.stroke();
        if (!desktopFrame) points.forEach(function (point) {
          overlayContext.beginPath();
          overlayContext.arc(point.x, point.y, Math.max(4, analysisWidth / 75), 0, Math.PI * 2);
          overlayContext.fillStyle = ready ? '#65d98b' : '#ffd166';
          overlayContext.fill();
        });
        overlayContext.restore();
      }

      function capture(points) {
        if (settled || !video.videoWidth || !video.videoHeight) return;
        settled = true;
        message.textContent = labels.ready;
        progress.style.width = '100%';
        var captureCanvas = document.createElement('canvas');
        var frame = desktopFrame ? cameraFrameRect(video.videoWidth, video.videoHeight, frameAspectRatio, frameScale) : null;
        captureCanvas.width = frame ? frame.width : video.videoWidth;
        captureCanvas.height = frame ? frame.height : video.videoHeight;
        var context = captureCanvas.getContext('2d');
        if (!context) {
          settled = false;
          finishError('scan_failed', labels.failed);
          return;
        }
        if (frame) {
          // Координаты берём из исходного видеокадра, а не из размера окна.
          context.drawImage(video, frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
        } else {
          context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
        }
        var dataUrl = captureCanvas.toDataURL('image/jpeg', imageQuality);
        var payload = JSON.stringify({
          image_base64: dataUrl.substring(dataUrl.indexOf(',') + 1),
          quad: manualCapture ? null : normalizedQuad(
            points || defaultQuad(analysisWidth, analysisHeight),
            analysisWidth,
            analysisHeight
          ),
        });
        // Let the green frame remain visible for one brief confirmation frame.
        scannerGlobal.setTimeout(function () {
          cleanup();
          resolve(payload);
        }, 120);
      }

      function analyze(timestamp) {
        if (settled) return;
        animationFrame = requestAnimationFrame(analyze);
        if (timestamp - lastAnalysisAt < ANALYSIS_INTERVAL_MS) return;
        lastAnalysisAt = timestamp;
        if (!analysisContext || video.readyState < 2) return;
        analysisContext.drawImage(video, 0, 0, analysisWidth, analysisHeight);
        var pixels = analysisContext.getImageData(
          0,
          0,
          analysisWidth,
          analysisHeight
        );
        var detection = detectDocumentQuad(pixels.data, analysisWidth, analysisHeight);
        if (!detection) {
          stableFrames = 0;
          previousRawQuad = null;
          displayedQuad = null;
          message.textContent = labels.wholeCard;
          progress.style.width = '0';
          drawOverlay(null, false);
          return;
        }

        var motion = quadMotion(
          previousRawQuad,
          detection.points,
          analysisWidth,
          analysisHeight
        );
        stableFrames = motion < 0.018
          ? Math.min(STABLE_FRAMES_REQUIRED, stableFrames + 1)
          : Math.max(0, stableFrames - 2);
        previousRawQuad = detection.points;
        displayedQuad = smoothQuad(displayedQuad, detection.points);
        var ready = stableFrames >= STABLE_FRAMES_REQUIRED;
        drawOverlay(displayedQuad, ready);
        progress.style.width = Math.round(
          stableFrames / STABLE_FRAMES_REQUIRED * 100
        ) + '%';
        message.textContent = ready
          ? labels.capturing
          : labels.hold;
        if (ready) capture(displayedQuad);
      }

      function onKeyDown(event) {
        if (event.key === 'Escape') finish(null);
        if (manualCapture && (event.key === ' ' || event.key === 'Enter') && !shutter.disabled && !event.repeat && event.target.tagName !== 'BUTTON' && event.target.tagName !== 'SELECT') {
          event.preventDefault();
          capture(null);
        }
      }

      function onPageHide() { finish(null); }
      document.addEventListener('keydown', onKeyDown);
      scannerGlobal.addEventListener('pagehide', onPageHide);
      if (manualCapture) {
        title.textContent = 'Камера';
        message.textContent = languageCode === 'ky' ? 'Карточканы кадрга жайгаштырып, тартыңыз' : 'Поместите карточку в кадр и нажмите «Снять»';
        progressTrack.style.display = 'none';
      }
      if (desktopFrame) {
        message.textContent = languageCode === 'ky' ? 'Карточканы алкакка жайгаштырып, тартыңыз' : 'Поместите карточку внутрь рамки и нажмите «Снять»';
      }

      cancel.addEventListener('click', function () { finish(null); });
      shutter.addEventListener('click', function () {
        capture(displayedQuad || defaultQuad(analysisWidth, analysisHeight));
      });

      document.body.append(root);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        finishError('unsupported', labels.unsupported);
        return;
      }

      function stopCurrentStream() {
        if (cancelVideoWait) cancelVideoWait();
        var previous = stream;
        stream = null;
        // Перед первым потоком не сбрасываем srcObject: это лишний переход
        // MediaElement, добавленный вместе с desktop-переключением камер.
        if (previous) {
          previous.getTracks().forEach(function (track) { track.stop(); });
          if (video.pause) video.pause();
          video.srcObject = null;
        }
      }

      function markDisconnected() {
        if (settled) return;
        cameraGeneration += 1;
        shutter.disabled = true;
        if (frameGuide) frameGuide.style.display = 'none';
        stopCurrentStream();
        message.textContent = labels.disconnected;
        if (compactUi) message.style.display = 'block';
        if (refreshCameras) refreshCameras.disabled = false;
      }

      async function updateCameraList() {
        if (!cameraSelect || settled) return;
        var listGeneration = ++deviceListGeneration;
        try {
          var devices = await mediaDevices.enumerateDevices();
          if (settled || listGeneration !== deviceListGeneration) return;
          var cameras = devices.filter(function (device) { return device.kind === 'videoinput'; });
          var selected = activeDeviceId || cameraSelect.value || rememberedDeviceId;
          cameraSelect.replaceChildren();
          var defaultOption = document.createElement('option');
          defaultOption.value = ''; defaultOption.textContent = labels.defaultCamera;
          cameraSelect.append(defaultOption);
          cameras.forEach(function (device, index) {
            var option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || labels.unnamedCamera + ' ' + (index + 1);
            cameraSelect.append(option);
          });
          cameraSelect.value = cameras.some(function (device) { return device.deviceId === selected; }) ? selected : '';
          cameraSelect.disabled = false;
          if (stream && activeDeviceId && !cameras.some(function (device) { return device.deviceId === activeDeviceId; })) markDisconnected();
        } catch (_) {
          // Снимок остаётся доступным, даже если браузер не разрешил перечень устройств.
          if (!settled && listGeneration === deviceListGeneration) cameraSelect.disabled = false;
        }
      }

      function onDeviceChange() { updateCameraList(); }

      async function openCamera(deviceId, initial) {
        if (settled) return;
        deviceListGeneration += 1;
        var generation = ++cameraGeneration;
        shutter.disabled = true;
        if (refreshCameras) refreshCameras.disabled = true;
        if (cameraSelect) cameraSelect.disabled = true;
        if (frameGuide) frameGuide.style.display = 'none';
        if (animationFrame) { cancelAnimationFrame(animationFrame); animationFrame = 0; }
        stopCurrentStream();
        stableFrames = 0; previousRawQuad = null; displayedQuad = null;
        var cameraStream = null;
        try {
          var constraints = { width: { ideal: 1920 }, height: { ideal: 1080 } };
          if (deviceId) constraints.deviceId = { exact: deviceId };
          else if (!desktopFrame) constraints.facingMode = { ideal: 'environment' };
          cameraStream = await mediaDevices.getUserMedia({ audio: false, video: constraints });
          // При отмене или быстром переключении поздний поток не должен ожить.
          if (settled || generation !== cameraGeneration) {
            cameraStream.getTracks().forEach(function (track) { track.stop(); });
            return;
          }
          stream = cameraStream;
          var track = cameraStream.getVideoTracks ? cameraStream.getVideoTracks()[0] : cameraStream.getTracks()[0];
          activeDeviceId = track && track.getSettings ? track.getSettings().deviceId || deviceId : deviceId;
          if (cameraSelect && track && track.addEventListener) track.addEventListener('ended', function () {
            if (stream === cameraStream && !settled) { markDisconnected(); updateCameraList(); }
          });
          video.srcObject = cameraStream;
          // У Safari play() иногда остаётся pending при уже доступных кадрах.
          // Готовность видео проверяем независимо, ошибки воспроизведения сохраняем.
          var playback = Promise.resolve(video.play()).then(function () {
            return new Promise(function () {});
          });
          await Promise.race([waitForVideoFrame(generation), playback]);
          if (settled || generation !== cameraGeneration) return;
        var sourceWidth = video.videoWidth;
        var sourceHeight = video.videoHeight;
        var scale = ANALYSIS_LONG_SIDE / Math.max(sourceWidth, sourceHeight);
        analysisWidth = Math.max(80, Math.round(sourceWidth * scale));
        analysisHeight = Math.max(80, Math.round(sourceHeight * scale));
        analysis.width = analysisWidth;
        analysis.height = analysisHeight;
        overlay.width = desktopFrame ? sourceWidth : analysisWidth;
        overlay.height = desktopFrame ? sourceHeight : analysisHeight;
        stage.style.aspectRatio = sourceWidth + ' / ' + sourceHeight;
        fitStage();
        scannerGlobal.addEventListener('resize', fitStage);
        if (!stageResizeObserver && typeof ResizeObserver !== 'undefined') {
          stageResizeObserver = new ResizeObserver(fitStage);
          stageResizeObserver.observe(viewport);
        }
        shutter.disabled = false;
        if (desktopFrame) {
          var frame = cameraFrameRect(sourceWidth, sourceHeight, frameAspectRatio, frameScale);
          // Рамка — отдельный слой DOM над видео, а не рисунок в canvas.
          frameGuide.style.left = frame.x / sourceWidth * 100 + '%';
          frameGuide.style.top = frame.y / sourceHeight * 100 + '%';
          frameGuide.style.width = frame.width / sourceWidth * 100 + '%';
          frameGuide.style.height = frame.height / sourceHeight * 100 + '%';
          frameGuide.style.display = 'block';
        }
        if (!manualCapture) animationFrame = requestAnimationFrame(analyze);

          if (desktopFrame) {
            message.textContent = languageCode === 'ky' ? 'Карточканы алкакка жайгаштырып, тартыңыз' : 'Поместите карточку внутрь рамки и нажмите «Снять»';
            if (compactUi) message.style.display = 'none';
            if (!initial) {
              rememberedDeviceId = deviceId;
              try { scannerGlobal.localStorage.setItem(selectionKey, deviceId); } catch (_) {}
            }
            await updateCameraList();
          }
        } catch (error) {
          if (settled || generation !== cameraGeneration) return;
          stopCurrentStream();
          if (initial && deviceId && error && (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')) {
            rememberedDeviceId = '';
            try { scannerGlobal.localStorage.removeItem(selectionKey); } catch (_) {}
            var fallback = openCamera('', true);
            var fallbackGeneration = cameraGeneration;
            await fallback;
            if (!settled && stream && fallbackGeneration === cameraGeneration) {
              message.textContent = labels.savedMissing;
              if (compactUi) message.style.display = 'block';
            }
            return;
          }
          var denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
          if (!desktopFrame || denied || !cameraSelect) {
            finishError(denied ? 'permission_denied' : 'scan_failed', denied ? labels.permission : labels.openFailed);
          } else {
            message.textContent = labels.openFailed;
            if (compactUi) message.style.display = 'block';
            await updateCameraList();
          }
        } finally {
          if (!settled && generation === cameraGeneration) {
            if (cameraSelect) cameraSelect.disabled = false;
            if (refreshCameras) refreshCameras.disabled = false;
          }
        }
      }

      openCamera(rememberedDeviceId, true);
    });
  };

  // Kept public for deterministic browser tests with synthetic frames.
  scannerGlobal.appWebDocumentScanner.detectDocumentQuad = detectDocumentQuad;
  scannerGlobal.appWebDocumentScanner.revision = 'desktop-frame-4';
  scannerGlobal.appWebDocumentScanner.assetRevision = 'mobile-preview-7';
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectDocumentQuad: detectDocumentQuad, cameraFrameRect: cameraFrameRect };
  }
})();
