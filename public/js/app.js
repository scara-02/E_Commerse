/**
 * NEXUS Flagship Store & Flash Sale - Frontend Controller
 * Complete E-Commerce Catalog, Shopping Cart, Orders & Distributed Queue Integration
 */

// ─── Global State ───
const API_BASE = '/api/v1';
let products = [];
let currentCategory = 'All';
let searchQuery = '';
let currentSort = 'featured';
let cart = [];
let appliedCoupon = null;

let authToken = localStorage.getItem('nexus_token') || null;
let currentUser = null;
let authMode = 'login';

let serverTimeOffset = 0;
let saleStartTime = null;
let isSaleActive = true;
let isSoldOut = false;
let turnstileToken = null;
let turnstileEnabled = false;

let pollInterval = null;
let pollCount = 0;
let activeReservationToken = null;
let activeOrderId = null;
let reservationExpiresAt = null;

// ─── Initialization ───
document.addEventListener('DOMContentLoaded', () => {
  loadSavedCart();
  fetchProducts();
  syncServerTime();
  checkAuthSession();

  // Polling server clock every second
  setInterval(tickClock, 1000);
  // Re-sync server time & sale status every 20 seconds
  setInterval(syncServerTime, 20000);

  // Keyboard shortcut: '/' focuses search input
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      const input = document.getElementById('searchInput');
      if (input) input.focus();
    }
  });
});

// ─── Edge CDN / Load Balancer Inspection ───
function updateNodeBadge(podId) {
  const badge = document.getElementById('nodeBadge');
  if (badge && podId) {
    badge.textContent = `⚡ Pod: ${podId}`;
    badge.title = `Request served by cluster pod: ${podId}`;
  }
}

// ─── Server Time Sync & Countdown ───
async function syncServerTime() {
  try {
    const res = await fetch(`${API_BASE}/checkout/status`);
    const servedBy = res.headers.get('X-Served-By');
    if (servedBy) updateNodeBadge(servedBy);

    const data = await res.json();
    if (data.serverTime) {
      serverTimeOffset = new Date(data.serverTime).getTime() - Date.now();
    }
    if (data.saleStartTime) {
      saleStartTime = new Date(data.saleStartTime).getTime();
    }
    isSaleActive = data.saleActive !== false;
    turnstileEnabled = data.turnstileEnabled === true;

    // Toggle Cloudflare Turnstile visibility
    const tw = document.getElementById('turnstileWrapper');
    if (tw) {
      tw.style.display = turnstileEnabled ? 'flex' : 'none';
    }

    updateHeroCountdown();
  } catch (err) {
    console.warn('[Sync] Status check failed:', err);
  }
}

function getServerNow() {
  return Date.now() + serverTimeOffset;
}

function tickClock() {
  const clockEl = document.getElementById('serverClock');
  if (clockEl) {
    const now = new Date(getServerNow());
    clockEl.textContent = now.toTimeString().split(' ')[0];
  }
  updateHeroCountdown();
}

function updateHeroCountdown() {
  const hoursEl = document.getElementById('hours');
  const minutesEl = document.getElementById('minutes');
  const secondsEl = document.getElementById('seconds');
  if (!hoursEl || !minutesEl || !secondsEl) return;

  const now = getServerNow();
  let diff = 0;

  if (saleStartTime && now < saleStartTime) {
    diff = saleStartTime - now;
  } else {
    // Sale is currently running or ends in 4 hours
    const midnight = new Date(now);
    midnight.setHours(23, 59, 59, 999);
    diff = midnight.getTime() - now;
  }

  if (diff < 0) diff = 0;

  const h = Math.floor(diff / (1000 * 60 * 60));
  const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const s = Math.floor((diff % (1000 * 60)) / 1000);

  hoursEl.textContent = String(h).padStart(2, '0');
  minutesEl.textContent = String(m).padStart(2, '0');
  secondsEl.textContent = String(s).padStart(2, '0');
}

// ─── Products Catalog & Storefront ───
let searchDebounceTimeout = null;

function handleSearch(val) {
  searchQuery = val.trim();
  const clearBtn = document.getElementById('searchClear');
  if (clearBtn) clearBtn.style.display = searchQuery ? 'block' : 'none';

  clearTimeout(searchDebounceTimeout);
  searchDebounceTimeout = setTimeout(() => {
    fetchProducts();
  }, 250);
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  handleSearch('');
}

function filterCategory(cat) {
  currentCategory = cat;

  // Update tabs UI
  const pills = document.querySelectorAll('.cat-pill');
  pills.forEach((p) => {
    if (p.textContent.trim() === cat || (cat === 'All' && p.textContent.trim() === 'All Products')) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });

  fetchProducts();
}

function handleSort(val) {
  currentSort = val;
  fetchProducts();
}

async function fetchProducts() {
  try {
    const params = new URLSearchParams();
    if (currentCategory && currentCategory !== 'All') {
      params.append('category', currentCategory);
    }
    if (searchQuery) {
      params.append('q', searchQuery);
    }
    if (currentSort) {
      params.append('sort', currentSort);
    }

    const res = await fetch(`${API_BASE}/products?${params.toString()}`);
    const servedBy = res.headers.get('X-Served-By');
    if (servedBy) updateNodeBadge(servedBy);

    const data = await res.json();
    if (data.success && Array.isArray(data.products)) {
      products = data.products;
      renderProductsGrid(products);
      updateHeroFromCatalog(products);

      const countEl = document.getElementById('productsCountText');
      if (countEl) countEl.textContent = `Showing ${products.length} devices`;
    }
  } catch (err) {
    console.error('[Catalog] Fetch error:', err);
    showToast('Failed to load catalog. Please check connection.', 'error');
  }
}

function updateHeroFromCatalog(list) {
  const heroProd = list.find((p) => p.isFlashSale) || list[0];
  if (!heroProd) return;

  const titleEl = document.getElementById('heroTitle');
  const descEl = document.getElementById('heroDesc');
  const stockText = document.getElementById('stockText');
  const stockFill = document.getElementById('stockMeterFill');

  if (titleEl) titleEl.textContent = heroProd.name;
  if (descEl) descEl.textContent = heroProd.description;
  if (stockText) stockText.textContent = `${heroProd.stock} units available`;
  if (stockFill && heroProd.totalStock > 0) {
    const pct = Math.max(5, Math.min(100, Math.round((heroProd.stock / heroProd.totalStock) * 100)));
    stockFill.style.width = `${pct}%`;
  }
}

function renderProductsGrid(list) {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  if (list.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 4rem 1rem; color: var(--text-muted);">
        <span style="font-size: 2.5rem; display: block; margin-bottom: 0.5rem;">🔍</span>
        <h3>No devices found</h3>
        <p style="font-size: 0.88rem; margin-top: 0.4rem;">Try adjusting your search terms or category filters.</p>
        <button class="btn btn-secondary btn-sm" style="margin-top: 1rem;" onclick="filterCategory('All')">Reset Filters</button>
      </div>
    `;
    return;
  }

  grid.innerHTML = list
    .map((p) => {
      const discountTag = p.discountPercent ? `<span class="card-discount">${p.discountPercent}% OFF</span>` : '';
      const origPrice = p.originalPrice ? `<span class="card-orig-price">₹${p.originalPrice.toLocaleString()}</span>` : '';
      const badgeClass = p.isFlashSale ? 'card-badge flash-badge' : 'card-badge';
      const badgeText = p.badge || (p.isFlashSale ? '⚡ FLASH DEAL' : 'PREMIUM');

      return `
        <article class="product-card" id="card-${p.id}">
          <div class="card-img-wrap" onclick="openQuickView('${p.id}')">
            <span class="${badgeClass}">${badgeText}</span>
            <img src="${p.imageUrl}" alt="${p.name}" class="card-img" loading="lazy" onerror="this.src='/images/phone_festival.png'">
          </div>
          <div class="card-body">
            <div class="card-cat-rating">
              <span>${p.category}</span>
              <span class="card-rating">★ ${p.rating.toFixed(1)} <small style="color:var(--text-dim);">(${p.reviewsCount})</small></span>
            </div>
            <h3 class="card-title" onclick="openQuickView('${p.id}')">${p.name}</h3>
            <p class="card-desc">${p.description}</p>
            
            <div class="card-price-row">
              <span class="card-price">₹${p.price.toLocaleString()}</span>
              ${origPrice}
              ${discountTag}
            </div>

            <div class="card-stock">
              ${p.stock > 0 ? `✓ In Stock (${p.stock} units)` : '<span style="color:var(--rose);">Out of Stock</span>'}
            </div>

            <div class="card-actions">
              <button class="btn btn-secondary btn-sm" onclick="addToCart('${p.id}', 1)" ${p.stock <= 0 ? 'disabled' : ''}>
                🛒 Add to Cart
              </button>
              <button class="btn btn-primary btn-sm" onclick="handleCardInstantBuy('${p.id}')" ${p.stock <= 0 ? 'disabled' : ''}>
                ⚡ ${p.isFlashSale ? 'Flash Buy' : 'Instant Buy'}
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

// ─── Product Quick View Modal ───
function openQuickView(productId) {
  const p = products.find((item) => item.id === productId);
  if (!p) return;

  const modal = document.getElementById('quickViewModal');
  const img = document.getElementById('qvImage');
  const badge = document.getElementById('qvBadge');
  const title = document.getElementById('qvTitle');
  const rating = document.getElementById('qvRating');
  const desc = document.getElementById('qvDescription');
  const price = document.getElementById('qvPrice');
  const origPrice = document.getElementById('qvOrigPrice');
  const discount = document.getElementById('qvDiscount');
  const stock = document.getElementById('qvStock');
  const addBtn = document.getElementById('qvAddToCartBtn');
  const buyBtn = document.getElementById('qvBuyNowBtn');

  if (img) img.src = p.imageUrl;
  if (badge) badge.textContent = p.badge || p.category;
  if (title) title.textContent = p.name;
  if (rating) rating.textContent = `★ ${p.rating.toFixed(1)} (${p.reviewsCount} customer reviews)`;
  if (desc) desc.textContent = p.description;
  if (price) price.textContent = `₹${p.price.toLocaleString()}`;
  if (origPrice) {
    origPrice.textContent = p.originalPrice ? `₹${p.originalPrice.toLocaleString()}` : '';
    origPrice.style.display = p.originalPrice ? 'inline' : 'none';
  }
  if (discount) {
    discount.textContent = p.discountPercent ? `${p.discountPercent}% OFF` : '';
    discount.style.display = p.discountPercent ? 'inline' : 'none';
  }
  if (stock) {
    stock.textContent = p.stock > 0 ? `✓ In Stock (${p.stock} units available)` : 'Out of Stock';
    stock.style.color = p.stock > 0 ? 'var(--emerald)' : 'var(--rose)';
  }

  if (addBtn) {
    addBtn.onclick = () => {
      addToCart(p.id, 1);
      closeQuickView();
    };
  }
  if (buyBtn) {
    buyBtn.onclick = () => {
      closeQuickView();
      handleCardInstantBuy(p.id);
    };
  }

  if (modal) modal.style.display = 'flex';
}

function closeQuickView() {
  const modal = document.getElementById('quickViewModal');
  if (modal) modal.style.display = 'none';
}

// ─── Shopping Cart Engine ───
function loadSavedCart() {
  try {
    const saved = localStorage.getItem('nexus_cart');
    if (saved) cart = JSON.parse(saved);
  } catch (_) {
    cart = [];
  }
  renderCartBadge();
}

function saveCart() {
  localStorage.setItem('nexus_cart', JSON.stringify(cart));
  renderCartBadge();
  renderCartDrawer();
}

function renderCartBadge() {
  const badge = document.getElementById('cartBadge');
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  if (badge) {
    badge.textContent = totalItems;
    badge.style.display = totalItems > 0 ? 'inline-block' : 'none';
  }
}

function toggleCartDrawer() {
  const drawer = document.getElementById('cartDrawer');
  const overlay = document.getElementById('cartOverlay');
  if (!drawer || !overlay) return;

  const isOpen = drawer.classList.contains('active');
  if (isOpen) {
    drawer.classList.remove('active');
    overlay.classList.remove('active');
  } else {
    renderCartDrawer();
    drawer.classList.add('active');
    overlay.classList.add('active');
  }
}

function addToCart(productId, quantity = 1) {
  const prod = products.find((p) => p.id === productId);
  if (!prod) return;

  const existing = cart.find((item) => item.productId === productId);
  if (existing) {
    existing.quantity = Math.min(prod.stock, existing.quantity + quantity);
  } else {
    cart.push({
      productId: prod.id,
      name: prod.name,
      price: prod.price,
      imageUrl: prod.imageUrl,
      category: prod.category,
      quantity: Math.min(prod.stock, quantity),
    });
  }

  saveCart();
  showToast(`Added ${prod.name} to cart`, 'success');
}

function updateCartQuantity(productId, delta) {
  const item = cart.find((it) => it.productId === productId);
  if (!item) return;

  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter((it) => it.productId !== productId);
  }
  saveCart();
}

function removeFromCart(productId) {
  cart = cart.filter((it) => it.productId !== productId);
  saveCart();
  showToast('Item removed from cart', 'info');
}

function applyCouponCode() {
  const input = document.getElementById('couponCodeInput');
  if (!input) return;

  const code = input.value.trim().toUpperCase();
  if (!code) return;

  if (code === 'FESTIVAL10') {
    appliedCoupon = { code, discountPercent: 10 };
    const successMsg = document.getElementById('couponSuccessMsg');
    if (successMsg) {
      successMsg.textContent = '✓ FESTIVAL10 Applied! 10% discount unlocked';
      successMsg.style.display = 'block';
    }
    showToast('Coupon FESTIVAL10 applied! 10% off', 'success');
    renderCartDrawer();
  } else {
    showToast('Invalid coupon code. Try FESTIVAL10', 'error');
  }
}

function usePresetCoupon(code) {
  const input = document.getElementById('couponCodeInput');
  if (input) {
    input.value = code;
    applyCouponCode();
  }
}

function renderCartDrawer() {
  const emptyState = document.getElementById('cartEmptyState');
  const itemsList = document.getElementById('cartItemsList');
  const footer = document.getElementById('cartFooter');
  const countHeader = document.getElementById('drawerCartCount');

  const totalItems = cart.reduce((sum, it) => sum + it.quantity, 0);
  if (countHeader) countHeader.textContent = `${totalItems} ${totalItems === 1 ? 'item' : 'items'}`;

  if (cart.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (itemsList) itemsList.style.display = 'none';
    if (footer) footer.style.display = 'none';
    return;
  }

  if (emptyState) emptyState.style.display = 'none';
  if (itemsList) itemsList.style.display = 'flex';
  if (footer) footer.style.display = 'flex';

  let subtotal = 0;

  itemsList.innerHTML = cart
    .map((item) => {
      const lineTotal = item.price * item.quantity;
      subtotal += lineTotal;

      return `
        <div class="cart-item">
          <img src="${item.imageUrl}" alt="${item.name}" class="cart-item-img" onerror="this.src='/images/phone_festival.png'">
          <div class="cart-item-info">
            <span class="cart-item-title">${item.name}</span>
            <span class="cart-item-price">₹${(item.price).toLocaleString()}</span>
            <div class="cart-qty-stepper">
              <button class="stepper-btn" onclick="updateCartQuantity('${item.productId}', -1)">-</button>
              <span class="stepper-val">${item.quantity}</span>
              <button class="stepper-btn" onclick="updateCartQuantity('${item.productId}', 1)">+</button>
            </div>
          </div>
          <button class="cart-item-remove" onclick="removeFromCart('${item.productId}')" title="Remove">✕</button>
        </div>
      `;
    })
    .join('');

  let discount = 0;
  if (appliedCoupon && appliedCoupon.discountPercent) {
    discount = Math.round(subtotal * (appliedCoupon.discountPercent / 100));
  }

  const grandTotal = Math.max(0, subtotal - discount);

  const subtotalEl = document.getElementById('cartSubtotal');
  const discountLine = document.getElementById('cartDiscountLine');
  const discountEl = document.getElementById('cartDiscount');
  const totalEl = document.getElementById('cartTotal');

  if (subtotalEl) subtotalEl.textContent = `₹${subtotal.toLocaleString()}`;
  if (discountLine && discountEl) {
    if (discount > 0) {
      discountLine.style.display = 'flex';
      discountEl.textContent = `-₹${discount.toLocaleString()}`;
    } else {
      discountLine.style.display = 'none';
    }
  }
  if (totalEl) totalEl.textContent = `₹${grandTotal.toLocaleString()}`;
}

// ─── Express Checkout Modal & Submission ───
function openCheckoutModal() {
  if (!authToken) {
    showToast('Please sign in to proceed with checkout', 'info');
    showAuthModal('login');
    return;
  }

  if (cart.length === 0) {
    showToast('Your cart is empty', 'error');
    return;
  }

  let subtotal = cart.reduce((sum, it) => sum + it.price * it.quantity, 0);
  let discount = appliedCoupon ? Math.round(subtotal * (appliedCoupon.discountPercent / 100)) : 0;
  let grandTotal = Math.max(0, subtotal - discount);

  const amountEl = document.getElementById('checkoutFinalAmount');
  if (amountEl) amountEl.textContent = `₹${grandTotal.toLocaleString()}`;

  const modal = document.getElementById('checkoutModal');
  if (modal) modal.style.display = 'flex';
}

function closeCheckoutModal() {
  const modal = document.getElementById('checkoutModal');
  if (modal) modal.style.display = 'none';
}

async function handleCartCheckout(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('checkoutSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing Order...';
  }

  const name = document.getElementById('shipName').value.trim();
  const phone = document.getElementById('shipPhone').value.trim();
  const address = document.getElementById('shipAddress').value.trim();
  const city = document.getElementById('shipCity').value.trim();
  const pin = document.getElementById('shipPin').value.trim();

  const payload = {
    items: cart.map((it) => ({ productId: it.productId, quantity: it.quantity })),
    couponCode: appliedCoupon ? appliedCoupon.code : null,
    shippingInfo: { name, phone, address, city, pin },
  };

  try {
    const res = await fetch(`${API_BASE}/orders/cart-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });

    const servedBy = res.headers.get('X-Served-By');
    if (servedBy) updateNodeBadge(servedBy);

    const data = await res.json();

    if (!res.ok) {
      showToast(data.message || 'Checkout failed. Please retry.', 'error');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Place Order & Confirm Payment';
      }
      return;
    }

    // Success! Clear cart
    cart = [];
    appliedCoupon = null;
    saveCart();
    closeCheckoutModal();
    toggleCartDrawer();

    showToast('🎉 Order confirmed! Items booked successfully.', 'success');

    // Automatically open orders drawer to display confirmed order
    setTimeout(() => {
      toggleOrdersDrawer();
    }, 600);
  } catch (err) {
    showToast('Network error during checkout.', 'error');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Place Order & Confirm Payment';
    }
  }
}

// ─── Instant Buy Triggers ───
function handleCardInstantBuy(productId) {
  const prod = products.find((p) => p.id === productId);
  if (!prod) return;

  if (prod.isFlashSale) {
    // High-concurrency queue engine
    triggerHeroCheckout();
  } else {
    // Add to cart & open checkout modal immediately
    cart = [{
      productId: prod.id,
      name: prod.name,
      price: prod.price,
      imageUrl: prod.imageUrl,
      category: prod.category,
      quantity: 1,
    }];
    saveCart();
    openCheckoutModal();
  }
}

function addHeroToCart() {
  const heroProd = products.find((p) => p.isFlashSale) || products[0];
  if (heroProd) addToCart(heroProd.id, 1);
}

// ─── High-Concurrency Distributed Flash Sale Checkout ───
async function triggerHeroCheckout() {
  if (!authToken) {
    showToast('Please sign in to participate in the flash sale', 'info');
    showAuthModal('login');
    return;
  }

  const buyButton = document.getElementById('buyButton');
  const buyText = document.getElementById('buyText');
  const buyLoader = document.getElementById('buyLoader');

  if (buyButton) buyButton.disabled = true;
  if (buyText) buyText.style.display = 'none';
  if (buyLoader) buyLoader.style.display = 'inline-flex';

  const idempotencyKey = crypto.randomUUID();
  const heroProd = products.find((p) => p.isFlashSale) || { id: 'phone_500' };

  try {
    const res = await fetch(`${API_BASE}/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        productId: heroProd.id,
        turnstileToken: turnstileToken || 'bypass-dev',
      }),
    });

    const servedBy = res.headers.get('X-Served-By');
    if (servedBy) updateNodeBadge(servedBy);

    const data = await res.json();

    if (res.status === 202) {
      // Order queued! Open queue modal & start polling
      activeReservationToken = data.token;
      showQueueModal(data.token);
      startOrderPolling(data.token);
      showToast('🎉 Queued in distributed broker! Securing stock...', 'success');
    } else if (res.status === 409) {
      showToast('⚠️ Maximum 1 unit per customer quota reached', 'error');
      if (buyButton) {
        buyButton.disabled = true;
        buyText.textContent = '⚠️ 1 Unit Limit Reached';
        buyText.style.display = 'inline';
        buyLoader.style.display = 'none';
      }
      return;
    } else if (res.status === 410) {
      showToast('😔 Flash sale product is sold out!', 'error');
      if (buyButton) {
        buyButton.disabled = true;
        buyText.textContent = 'Sold Out';
        buyText.style.display = 'inline';
        buyLoader.style.display = 'none';
      }
      return;
    } else {
      showToast(data.message || 'Failed to place reservation', 'error');
    }
  } catch (err) {
    showToast('Network error during flash checkout', 'error');
  } finally {
    if (buyButton && !buyButton.disabled) {
      buyButton.disabled = false;
      if (buyText) buyText.style.display = 'inline';
      if (buyLoader) buyLoader.style.display = 'none';
    }
  }
}

// ─── Queue Status Modal & Polling Pipeline ───
function showQueueModal(token) {
  const modal = document.getElementById('queueStatusOverlay');
  const tokenText = document.getElementById('queueTokenText');
  if (tokenText) tokenText.textContent = token;
  if (modal) modal.style.display = 'flex';
  updatePipelineStep(1, 'QUEUED', 'Queued in distributed RabbitMQ cluster', 25);
}

function closeQueueModal() {
  const modal = document.getElementById('queueStatusOverlay');
  if (modal) modal.style.display = 'none';
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function updatePipelineStep(stepNum, badgeText, phaseText, progressPct) {
  const badge = document.getElementById('queueStatusBadge');
  const phase = document.getElementById('queuePhaseText');
  const bar = document.getElementById('queueProgressBar');

  if (badge) {
    badge.textContent = badgeText;
    badge.className = `status-pill status-${badgeText.toLowerCase()}`;
  }
  if (phase) phase.textContent = phaseText;
  if (bar) bar.style.width = `${progressPct}%`;

  for (let i = 1; i <= 4; i++) {
    const node = document.getElementById(`stepNode${i}`);
    if (node) {
      if (i <= stepNum) node.classList.add('active');
      else node.classList.remove('active');
    }
  }
}

function startOrderPolling(token) {
  pollCount = 0;
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    pollCount++;
    if (pollCount > 60) {
      clearInterval(pollInterval);
      showToast('Polling timed out. Check your order status under My Orders.', 'info');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/orders/status/${token}`);
      const servedBy = res.headers.get('X-Served-By');
      if (servedBy) updateNodeBadge(servedBy);

      if (res.status === 404) {
        updatePipelineStep(1, 'EXPIRED', 'Reservation expired or not found', 10);
        clearInterval(pollInterval);
        return;
      }

      const data = await res.json();
      const order = data.order;
      if (!order) return;

      if (order.status === 'PROCESSING') {
        updatePipelineStep(2, 'PROCESSING', 'Worker consuming order from queue & executing DB locks', 50);
      } else if (order.status === 'RESERVED') {
        activeOrderId = order.orderId;
        updatePipelineStep(3, 'RESERVED', 'Inventory reserved in PostgreSQL! Please confirm payment within TTL.', 75);

        const actionBox = document.getElementById('queueActionBox');
        if (actionBox) actionBox.style.display = 'block';

        if (order.expiresAt) {
          const ttlSec = Math.max(0, Math.floor((new Date(order.expiresAt).getTime() - getServerNow()) / 1000));
          const mins = Math.floor(ttlSec / 60);
          const secs = ttlSec % 60;
          const expiryEl = document.getElementById('queueExpiryText');
          if (expiryEl) expiryEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
        }
      } else if (order.status === 'CONFIRMED') {
        updatePipelineStep(4, 'CONFIRMED', 'Payment verified and stock confirmed!', 100);
        clearInterval(pollInterval);
        setTimeout(() => {
          closeQueueModal();
          toggleOrdersDrawer();
        }, 1500);
      }
    } catch (_) {}
  }, 1000);
}

async function confirmFlashOrder() {
  if (!activeOrderId) return;
  const btn = document.getElementById('confirmPaymentBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Confirming Payment...';
  }

  try {
    const res = await fetch(`${API_BASE}/orders/${activeOrderId}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ paymentReference: `FLASH-PAY-${Date.now()}` }),
    });

    const data = await res.json();
    if (res.ok) {
      updatePipelineStep(4, 'CONFIRMED', 'Payment verified & order finalized!', 100);
      showToast('Order confirmed successfully!', 'success');
      setTimeout(() => {
        closeQueueModal();
        toggleOrdersDrawer();
      }, 1200);
    } else {
      showToast(data.message || 'Payment confirmation failed', 'error');
    }
  } catch (err) {
    showToast('Network error during confirmation', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✅ Finalize & Pay ₹29,999';
    }
  }
}

// ─── My Orders Drawer ───
async function toggleOrdersDrawer() {
  if (!authToken) {
    showToast('Please sign in to view your orders', 'info');
    showAuthModal('login');
    return;
  }

  const drawer = document.getElementById('ordersDrawer');
  const overlay = document.getElementById('ordersOverlay');
  if (!drawer || !overlay) return;

  const isOpen = drawer.classList.contains('active');
  if (isOpen) {
    drawer.classList.remove('active');
    overlay.classList.remove('active');
  } else {
    drawer.classList.add('active');
    overlay.classList.add('active');
    fetchUserOrders();
  }
}

async function fetchUserOrders() {
  const listEl = document.getElementById('ordersList');
  const countEl = document.getElementById('ordersHeaderCount');
  if (!listEl) return;

  listEl.innerHTML = `
    <div style="text-align:center; padding: 2rem; color: var(--text-dim);">
      <span class="spinner"></span> Loading orders...
    </div>
  `;

  try {
    const res = await fetch(`${API_BASE}/orders/my`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const servedBy = res.headers.get('X-Served-By');
    if (servedBy) updateNodeBadge(servedBy);

    const data = await res.json();
    const orders = data.orders || [];

    if (countEl) countEl.textContent = `${orders.length} ${orders.length === 1 ? 'order' : 'orders'}`;

    if (orders.length === 0) {
      listEl.innerHTML = `
        <div class="cart-empty-state">
          <span class="empty-cart-icon">📦</span>
          <h4>No orders yet</h4>
          <p>Your confirmed purchases and reservations will appear here.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = orders
      .map((ord) => {
        const dateStr = ord.createdAt ? new Date(ord.createdAt).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        const statusClass = `status-${ord.status.toLowerCase()}`;
        const canConfirm = ord.status === 'RESERVED';

        return `
          <div class="order-history-card">
            <div class="oh-header">
              <span class="oh-id">#${ord.id.substring(0, 8)}...</span>
              <span class="status-pill ${statusClass}">${ord.status}</span>
            </div>
            <div class="oh-product">
              <img src="${ord.productImage || '/images/phone_festival.png'}" alt="Product" class="oh-thumb" onerror="this.src='/images/phone_festival.png'">
              <div>
                <div class="oh-title">${ord.productName || ord.productId}</div>
                <div style="font-size:0.75rem; color:var(--text-dim);">${dateStr}</div>
              </div>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.3rem;">
              <span class="oh-amount">₹${parseFloat(ord.amount || 0).toLocaleString()}</span>
              ${canConfirm ? `<button class="btn btn-primary btn-sm" onclick="confirmExistingReservedOrder('${ord.id}')">Pay Now</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  } catch (err) {
    listEl.innerHTML = '<div style="color:var(--rose); padding:1rem; text-align:center;">Failed to fetch orders.</div>';
  }
}

async function confirmExistingReservedOrder(orderId) {
  try {
    const res = await fetch(`${API_BASE}/orders/${orderId}/confirm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ paymentReference: `PAY-MANUAL-${Date.now()}` }),
    });

    if (res.ok) {
      showToast('Order confirmed and paid!', 'success');
      fetchUserOrders();
    } else {
      showToast('Confirmation failed. Order may have expired.', 'error');
    }
  } catch (_) {
    showToast('Network error during confirmation', 'error');
  }
}

// ─── User Profile & Account Modal ───
function toggleUserDropdown() {
  const dd = document.getElementById('userDropdown');
  if (dd) {
    dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
  }
}

document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('authWrapper');
  const dd = document.getElementById('userDropdown');
  if (wrapper && dd && !wrapper.contains(e.target)) {
    dd.style.display = 'none';
  }
});

async function checkAuthSession() {
  if (!authToken) {
    updateAuthUI(null);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      updateAuthUI(currentUser);
    } else {
      logout();
    }
  } catch (_) {
    updateAuthUI(null);
  }
}

function updateAuthUI(user) {
  const loginBtn = document.getElementById('loginBtn');
  const userMenu = document.getElementById('userMenu');
  const usernameDisplay = document.getElementById('usernameDisplay');
  const avatar = document.getElementById('userAvatar');
  const menuFullname = document.getElementById('menuFullname');

  if (user) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (userMenu) userMenu.style.display = 'block';
    if (usernameDisplay) usernameDisplay.textContent = user.username;
    if (avatar) avatar.textContent = user.username.charAt(0).toUpperCase();
    if (menuFullname) menuFullname.textContent = `Signed in as @${user.username}`;
  } else {
    if (loginBtn) loginBtn.style.display = 'block';
    if (userMenu) userMenu.style.display = 'none';
  }
}

function showAccountModal() {
  if (!currentUser) return;
  const modal = document.getElementById('accountModal');
  const u = document.getElementById('accUsername');
  const e = document.getElementById('accEmail');
  const p = document.getElementById('accPhone');
  const a = document.getElementById('accAge');

  if (u) u.textContent = currentUser.username;
  if (e) e.textContent = currentUser.email;
  if (p) p.textContent = currentUser.phoneVerified ? '✓ Verified' : 'Unverified';
  if (a) a.textContent = `${currentUser.accountAgeDays || 30} days`;

  if (modal) modal.style.display = 'flex';
}

function closeAccountModal() {
  const modal = document.getElementById('accountModal');
  if (modal) modal.style.display = 'none';
}

// ─── Auth Modal & 1-Click Demo Logins ───
function showAuthModal(mode) {
  authMode = mode;
  const modal = document.getElementById('authModal');
  const title = document.getElementById('authTitle');
  const emailGroup = document.getElementById('emailGroup');
  const submitBtn = document.getElementById('authSubmit');
  const toggleText = document.getElementById('authToggleText');
  const toggleLink = document.getElementById('authToggleLink');
  const errorEl = document.getElementById('authError');

  if (errorEl) errorEl.style.display = 'none';

  if (mode === 'register') {
    if (title) title.textContent = 'Create NEXUS Account';
    if (emailGroup) emailGroup.style.display = 'flex';
    if (submitBtn) submitBtn.textContent = 'Create Account';
    if (toggleText) toggleText.textContent = 'Already have an account?';
    if (toggleLink) toggleLink.textContent = 'Sign In';
  } else {
    if (title) title.textContent = 'Sign In to NEXUS';
    if (emailGroup) emailGroup.style.display = 'none';
    if (submitBtn) submitBtn.textContent = 'Sign In';
    if (toggleText) toggleText.textContent = 'New customer?';
    if (toggleLink) toggleLink.textContent = 'Create an account';
  }

  if (modal) modal.style.display = 'flex';
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.style.display = 'none';
}

function toggleAuthMode(e) {
  e.preventDefault();
  showAuthModal(authMode === 'login' ? 'register' : 'login');
}

async function quickDemoLogin(username) {
  const uInput = document.getElementById('authUsername');
  const pInput = document.getElementById('authPassword');
  if (uInput) uInput.value = username;
  if (pInput) pInput.value = 'DemoPass123!';

  await executeAuthRequest('/auth/login', { username, password: 'DemoPass123!' });
}

async function handleAuth(e) {
  e.preventDefault();
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const endpoint = authMode === 'register' ? '/auth/register' : '/auth/login';

  const body = { username, password };
  if (authMode === 'register') {
    const email = document.getElementById('authEmail').value.trim();
    if (!email) {
      showAuthError('Email address is required');
      return;
    }
    body.email = email;
  }

  await executeAuthRequest(endpoint, body);
}

async function executeAuthRequest(endpoint, body) {
  const errorEl = document.getElementById('authError');
  if (errorEl) errorEl.style.display = 'none';

  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (!res.ok) {
      showAuthError(data.message || 'Authentication failed');
      return;
    }

    authToken = data.token;
    localStorage.setItem('nexus_token', authToken);
    currentUser = data.user;
    updateAuthUI(currentUser);
    closeAuthModal();

    showToast(`Welcome, ${currentUser.username}!`, 'success');
  } catch (err) {
    showAuthError('Connection error. Please try again.');
  }
}

function showAuthError(msg) {
  const errorEl = document.getElementById('authError');
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('nexus_token');
  updateAuthUI(null);
  showToast('Signed out successfully', 'info');
}

// ─── Cloudflare Turnstile Callback ───
window.onTurnstileSuccess = function (token) {
  turnstileToken = token;
};

// ─── Floating Toast System ───
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icon = type === 'success' ? '✓' : type === 'error' ? '⚠️' : 'ℹ️';
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 3500);
}
