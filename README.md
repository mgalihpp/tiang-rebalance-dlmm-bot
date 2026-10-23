<p align="center">
  <img src="assets/banner.svg" alt="Auto-rebalance DLMM bot for Solana and Meteora" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000000" alt="Bun">
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=ffffff" alt="TypeScript">
  <img src="https://img.shields.io/badge/effects-Effect-5B4FE9" alt="Effect">
  <img src="https://img.shields.io/badge/chain-Solana-9945FF?logo=solana&logoColor=ffffff" alt="Solana">
  <img src="https://img.shields.io/badge/DEX-Meteora%20DLMM-00B8D9" alt="Meteora DLMM">
</p>

# DLMM tight-range bot

Bot untuk satu pool Meteora DLMM. Dia membuka posisi selebar 1 atau 2 bin di sekitar
active bin, lalu menutup dan membuka ulang posisi ketika harga keluar dari range itu.
Seluruh saldo token pasangan di wallet dipakai lagi saat membuka ulang, jadi fee yang
sudah diklaim ikut masuk ke posisi baru.

Uang sungguhan. Baca bagian risiko sebelum menyalakan `LIVE`.

## Satu siklus

```text
main() [1] ← satu pool, satu wallet
├── observe(chain) [1a] ← baca chain, bukan cache
│   ├── pool.refetchStates() [1a1]
│   ├── getPositionsByUserAndLbPair(owner) [1a2] ← posisi + active bin
│   ├── wallet: SOL, tokenX, tokenY [1a3]
│   └── depositsEnabled: lbPair.status == 0 dan swap tidak dimatikan [1a4]
├── decide(snapshot, policy, history) [1b] ← fungsi murni, tanpa I/O
│   ├── if wallet.sol < reserve: [1b1]
│   │   └── Halt "sol-reserve" [1b1a]
│   ├── if positions > 1: [1b2]
│   │   └── Close duplikat, sisakan yang paling dekat [1b2a]
│   ├── if ada posisi dan active bin di luar range: [1b3]
│   │   └── Rebalance [1b3a] ← tutup lalu buka ulang
│   ├── if ada posisi dan masih di range: [1b4]
│   │   └── Idle "in-range" [1b4a]
│   ├── if rebalance sejam terakhir >= batas: [1b5]
│   │   └── Halt "thrash" [1b5a]
│   ├── if cooldown / dwell belum lewat: [1b6]
│   │   └── Idle [1b6a]
│   └── otherwise: [1b7]
│       └── Open [1b7a] ← range = [active, active + width - 1]
├── act(ctx, decision) [1c]
│   ├── Open: [1c1]
│   │   ├── Keypair baru untuk position account [1c1a]
│   │   ├── initializePositionAndAddLiquidityByStrategy(...) [1c1b]
│   │   └── sendTx: compute budget, simulate, sign, send, confirm [1c1c]
│   ├── Rebalance: [1c2]
│   │   ├── removeLiquidity({ bps: 10000, shouldClaimAndClose: true }) [1c2a]
│   │   ├── observe ulang setelah close terkonfirmasi [1c2b]
│   │   └── open dari saldo wallet yang baru [1c2c]
│   └── Close: [1c3]
│       └── jalur tutup yang sama [1c3a]
└── journal + sleep(pollIntervalMs) [1d]
```

`decide` tidak menyimpan state. Satu-satunya sumber kebenaran adalah chain. Kalau
proses mati di tengah rebalance, siklus berikutnya melihat posisi yang sebenarnya
dan mengambil langkah dari situ.

## Yang wajib kamu tahu soal range 1 bin

DLMM mengisi tiap bin dengan satu token saja. Bin di bawah harga aktif berisi token Y,
bin di atasnya berisi token X. Posisi satu bin tepat di active bin karena itu hanya
memakai satu sisi, default token Y. Untuk pool SOL/USDC, X = SOL dan Y = USDC.

Artinya:

- Range 1 bin `[a, a]` = semua modal di Y. Harga turun melewati bin itu mengubah Y
  jadi X. Setelah itu wallet hanya punya X, dan bot membuka ulang single-sided X.
  Harga naik lagi mengubahnya balik ke Y.
- Range 2 bin single-sided Y `[a-1, a]` memakai SOL di dua bin sisi Y.
- Range 2 bin single-sided X `[a, a+1]` memakai token X di dua bin sisi X.
- Bot hanya mendepositkan satu sisi. Jika wallet berisi X dan Y, bot memilih sisi
  dengan nilai lebih besar pada harga bin aktif dan membiarkan token sisi lain di wallet.

Bot tidak menukar token lewat Jupiter. Dia memakai token yang benar-benar ada di
wallet, jadi tidak ada swap paksa yang merealisasikan kerugian di tengah siklus.

Kalau salah satu sisi pool adalah wrapped SOL, bot menghitung SOL native di atas
`MIN_SOL_RESERVE_SOL` sebagai saldo sisi itu. SDK Meteora membungkusnya jadi wSOL
di dalam transaksi open yang sama, lalu mengembalikannya jadi SOL native saat close.
Wallet yang hanya berisi SOL bisa membuka posisi di pool TOKEN/SOL tanpa langkah manual.

## Keamanan

- `DRY_RUN=true` adalah default. Bot tetap menyusun dan menyimulasikan transaksi,
  tapi tidak mengirim.
- `LIVE=true` wajib disertai `DRY_RUN=false` dan flag `--confirm-live` saat start.
  Tanpa itu, proses keluar dengan kode 1.
- Setiap transaksi disimulasikan dulu. Kalau simulasi gagal, tidak ada yang dikirim.
- `MAX_REBALANCES_PER_HOUR` menghentikan bot dan menulis file `state/HALT` ketika
  pasar terlalu sering bolak-balik. Hapus file itu hanya setelah memeriksa journal.
- `MIN_SOL_RESERVE_SOL` menjaga SOL untuk fee. Reserve dicek saat tidak ada posisi,
  jadi bot berhenti membuka posisi baru tapi tetap mengelola posisi yang sudah terbuka.
  Sisakan ruang, karena rent posisi dan bin array dibayar dari SOL native saat open.
  Reserve yang terlalu mepet dengan saldo sisa membuat siklus berikutnya langsung halt.
- `DWELL_TICKS` menahan pembukaan sampai active bin stabil beberapa siklus.
- `MAX_DEPLOY_X` dan `MAX_DEPLOY_Y` membatasi jumlah token mentah yang dipakai.
- Semua keputusan dan hasil ditulis ke `state/journal.jsonl`.

## Menjalankan

Butuh Bun 1.2 atau lebih baru.

```bash
bun install
cp .env.example .env
# isi RPC_URL, POOL_ADDRESS, dan wallet

bun run probe     # baca pool saja, tanpa wallet berisi uang
bun run once      # satu siklus, default dry-run
bun run dev       # loop terus, dry-run
bun src/main.ts --confirm-live   # loop terus dengan uang sungguhan
```

Wallet: isi `WALLET_KEYPAIR_PATH` dengan file yang berisi array JSON secret key
(`wallet.json`) atau teks base58 dari export Phantom/Backpack. Keduanya diterima
di file maupun di `WALLET_SECRET_KEY`. File base58 boleh berisi satu baris saja. Pakai wallet khusus bot, karena bot memakai seluruh
saldo token pasangan yang ada di dalamnya.

Private key di environment lebih mudah bocor lewat shell history, `docker inspect`,
atau log proses. Untuk uang sungguhan, pakai `WALLET_KEYPAIR_PATH` dengan file
yang hanya bisa dibaca user bot.

`bun run probe` hanya butuh RPC. Mode lain menyusun transaksi dan karena itu butuh
wallet yang sudah punya SOL dan token, walaupun masih dry-run.

## Environment

| Variabel | Default | Arti |
| --- | --- | --- |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | HTTP RPC. RPC publik terlalu lambat untuk range 1 bin. |
| `WS_URL` | Turunan dari `RPC_URL` | Disimpan untuk pemakaian berikutnya, belum dipakai loop. |
| `POOL_ADDRESS` | wajib | Alamat pool DLMM. |
| `WALLET_KEYPAIR_PATH` | wajib, atau `WALLET_SECRET_KEY` | File secret key. Array JSON atau teks base58. |
| `WALLET_SECRET_KEY` | kosong | Alternatif file. Base58 64 byte, seed base58 32 byte, atau array JSON. |
| `POSITION_WIDTH` | `1` | `1` atau `2` bin. |
| `SLIPPAGE_PERCENT` | `1` | Persen, bukan bps. SDK mengubahnya jadi jumlah bin. |
| `MAX_DEPLOY_X`, `MAX_DEPLOY_Y` | tanpa batas | Batas token mentah per posisi. |
| `MIN_SOL_RESERVE_SOL` | `0.05` | SOL yang tidak boleh dipakai. |
| `PRIORITY_FEE_MICRO_LAMPORTS` | `50000` | Fee per compute unit. |
| `MAX_PRIORITY_FEE_MICRO_LAMPORTS` | `2000000` | Batas atas fee. |
| `POLL_INTERVAL_MS` | `4000` | Jeda antar siklus. |
| `DWELL_TICKS` | `2` | Siklus berturut-turut dengan active bin sama sebelum open. |
| `MAX_REBALANCES_PER_HOUR` | `20` | Batas rebalance per jam. |
| `MIN_REBALANCE_INTERVAL_MS` | `60000` | Jeda minimum sebelum open berikutnya. |
| `MAX_SNAPSHOT_AGE_MS` | `30000` | Batas umur snapshot. |
| `STATE_DIR` | `./state` | Journal dan file HALT. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `DRY_RUN` | `true` | Simulasi saja. |
| `LIVE` | `false` | Harus `true` bersama `DRY_RUN=false`. |

## Biaya yang harus dihitung

Range 1 sampai 2 bin berputar sering. Tiap putaran membayar:

- priority fee dan base fee untuk dua transaksi, close dan open;
- composition fee saat deposit masuk ke active bin yang tidak kosong, karena deposit
  menggeser komposisi bin seperti swap;
- rent bin array 0.0714 SOL kalau range menyentuh bin array baru. Array ini milik pool
  dan tidak ditutup saat posisimu ditutup. Dokumen Meteora tidak menjanjikan refund,
  jadi perlakukan sebagai biaya hangus;
- rent position account, kembali saat posisi ditutup.

Helius berbayar per tier: Agent 10 USD sekali bayar dengan 1 juta kredit, Developer
49 USD dengan 10 juta kredit, dan seterusnya. Stream WebSocket memakai 1 kredit saat
koneksi dibuka plus 2 kredit per 0.1 MB data. Bot ini hanya polling, jadi biaya RPC
mengikuti jumlah siklus. RPC apa pun yang kompatibel bisa dipakai.

## Verifikasi

Sudah dijalankan:

- `bunx tsc --noEmit` bersih.
- `bun run test` 40 test lulus, mencakup aturan keputusan, parsing config, dan bin math.
- `bun run probe` pada pool SOL/USDC mainnet `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`
  mengembalikan active bin, bin step 4, dua mint dengan decimals yang benar, dan
  `depositsEnabled: true`.
- `bun scripts/selfcheck.ts` menyusun transaksi open untuk range 1 bin: 9 instruction
  (compute budget, position init, dua ATA, transfer fee, add liquidity) dengan program
  ID DLMM yang benar.
- `bun src/main.ts --once` pada wallet kosong berhenti di `Halt "sol-reserve"`. Dengan
  `MIN_SOL_RESERVE_SOL=0` siklus yang sama berakhir di `Idle "no-inventory"` dan keluar
  dengan kode 0, jadi loop, journal, dan gate konfigurasi benar-benar jalan.
- `bun src/main.ts --once` dengan `DRY_RUN=true` pada wallet berisi 0.5 SOL dan pool
  `TOKEN/SOL` memutuskan `Open` dengan 0.3 SOL dari sisi wSOL, lalu transaksi open
  hasil simulasi lolos. SDK membungkus SOL native di dalam transaksi yang sama.

Belum diverifikasi, karena butuh wallet berisi dana: pengiriman transaksi sungguhan,
close dengan claim fee, dan hasil rebalance end-to-end. Jalankan `bun run once` dengan
wallet kecil dan `DRY_RUN=true` dulu. Simulasi akan gagal kalau saldo kurang, jadi
dry-run yang sukses adalah bukti transaksi bisa dieksekusi.

## Batasan

- Satu pool, satu wallet, satu proses. Tidak ada mode multi-pool.
- Belum ada WebSocket trigger. Reaksi mengikuti `POLL_INTERVAL_MS`. Untuk range 1 bin,
  pakai 1000 sampai 2000 ms dan RPC berbayar.
- Belum ada swap. Kalau ingin selalu kembali ke token Y setelah harga turun, itu
  perubahan terpisah dan menambah jalur risiko.
- Angka profit belum dihitung otomatis. `state/journal.jsonl` menyimpan semua
  kejadian, cukup untuk menghitung PnL belakangan.
