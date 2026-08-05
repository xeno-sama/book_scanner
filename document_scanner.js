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

  scannerGlobal.appWebDocumentScanner = function (languageCode) {
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
      openFailed: 'Арткы камераны ачуу мүмкүн болгон жок',
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
      openFailed: 'Не удалось открыть заднюю камеру',
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

      var root = document.createElement('div');
      root.id = 'app-web-document-scanner';
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
      stage.style.cssText = 'position:relative;max-width:100%;max-height:100%;overflow:hidden';
      var video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;background:black';
      var overlay = document.createElement('canvas');
      overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      stage.append(video, overlay);
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
      shutter.textContent = labels.shutter;
      shutter.style.cssText = buttonStyle('white-space:nowrap');
      footer.append(messageWrap, shutter);
      root.append(header, viewport, footer);

      var analysis = document.createElement('canvas');
      var analysisContext = analysis.getContext('2d', { willReadFrequently: true });
      var overlayContext = overlay.getContext('2d');

      function cleanup() {
        if (animationFrame) cancelAnimationFrame(animationFrame);
        if (stream) {
          stream.getTracks().forEach(function (track) { track.stop(); });
        }
        root.remove();
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

      function drawOverlay(points, ready) {
        if (!overlayContext) return;
        overlayContext.clearRect(0, 0, analysisWidth, analysisHeight);
        if (!points) return;
        overlayContext.save();
        overlayContext.fillStyle = 'rgba(0,0,0,.42)';
        overlayContext.beginPath();
        overlayContext.rect(0, 0, analysisWidth, analysisHeight);
        overlayContext.moveTo(points[0].x, points[0].y);
        for (var index = 1; index < points.length; index += 1) {
          overlayContext.lineTo(points[index].x, points[index].y);
        }
        overlayContext.closePath();
        overlayContext.fill('evenodd');
        overlayContext.strokeStyle = ready ? '#65d98b' : '#ffd166';
        overlayContext.lineWidth = Math.max(2, analysisWidth / 120);
        overlayContext.lineJoin = 'round';
        overlayContext.beginPath();
        overlayContext.moveTo(points[0].x, points[0].y);
        for (var pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
          overlayContext.lineTo(points[pointIndex].x, points[pointIndex].y);
        }
        overlayContext.closePath();
        overlayContext.stroke();
        points.forEach(function (point) {
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
        captureCanvas.width = video.videoWidth;
        captureCanvas.height = video.videoHeight;
        var context = captureCanvas.getContext('2d');
        if (!context) {
          settled = false;
          finishError('scan_failed', labels.failed);
          return;
        }
        context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
        var dataUrl = captureCanvas.toDataURL('image/jpeg', 0.96);
        var payload = JSON.stringify({
          image_base64: dataUrl.substring(dataUrl.indexOf(',') + 1),
          quad: normalizedQuad(
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

      cancel.addEventListener('click', function () { finish(null); });
      shutter.addEventListener('click', function () {
        capture(displayedQuad || defaultQuad(analysisWidth, analysisHeight));
      });

      document.body.append(root);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        finishError('unsupported', labels.unsupported);
        return;
      }

      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      }).then(function (cameraStream) {
        stream = cameraStream;
        video.srcObject = cameraStream;
        return video.play();
      }).then(function () {
        var sourceWidth = video.videoWidth || 1280;
        var sourceHeight = video.videoHeight || 720;
        var scale = ANALYSIS_LONG_SIDE / Math.max(sourceWidth, sourceHeight);
        analysisWidth = Math.max(80, Math.round(sourceWidth * scale));
        analysisHeight = Math.max(80, Math.round(sourceHeight * scale));
        analysis.width = analysisWidth;
        analysis.height = analysisHeight;
        overlay.width = analysisWidth;
        overlay.height = analysisHeight;
        stage.style.aspectRatio = sourceWidth + ' / ' + sourceHeight;
        if (sourceWidth >= sourceHeight) {
          stage.style.width = '100%';
          stage.style.height = 'auto';
        } else {
          stage.style.height = '100%';
          stage.style.width = 'auto';
        }
        animationFrame = requestAnimationFrame(analyze);
      }).catch(function (error) {
        var denied = error && (
          error.name === 'NotAllowedError' || error.name === 'SecurityError'
        );
        finishError(
          denied ? 'permission_denied' : 'unsupported',
          denied
            ? labels.permission
            : labels.openFailed
        );
      });
    });
  };

  // Kept public for deterministic browser tests with synthetic frames.
  scannerGlobal.appWebDocumentScanner.detectDocumentQuad = detectDocumentQuad;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { detectDocumentQuad: detectDocumentQuad };
  }
})();
