# Bản theo dõi trên Cloudflare (Pages + R2)

Địa chỉ: **https://theme-check.pages.dev**. Mở trang, nhập **mã truy cập của team** một lần (trình duyệt nhớ 30 ngày), và xem tiến độ đang chạy theo từng theme, số liệu từng lần chạy, issue tracker, báo cáo, và **ảnh chụp màn hình tại khoảnh khắc lỗi** hiện thẳng trong trang. Không còn video.

```text
Máy chạy check ──(tiến độ ~30 giây/lần; kết quả, báo cáo, ảnh khi chạy xong)──▶ Pages Functions ──▶ R2 (một bucket)
Team ──(mã truy cập, cookie)──▶ dashboard ─────────────────────────────────────────────────────────┘
```

## Cái gì ở đâu

| Thứ | Nằm ở |
|---|---|
| Tiến độ, số liệu, issue tracker, danh sách theme | R2: `data/state.json`, `data/progress.json` |
| `report.html`, `summary.json`, `results.json` và ảnh chụp lỗi của từng lần chạy | R2: `runs/<ngày>-<env>/...` |
| Cùng các file trên | Máy chạy check: `history/runs/...` (xem ngay ở `http://127.0.0.1:4173`) |

Ảnh của check đã pass bị xóa sau mỗi lần chạy, chỉ giữ ảnh của check lỗi hoặc cần xem tay. Một lần chạy đầy đủ vì thế nhỏ (ước tính vài chục MB), R2 miễn phí 10 GB là đủ cho nhiều tháng. Giá và hạn mức có thể đổi, xem trang giá R2 hiện tại.

## Cài đặt (làm một lần)

### 1. Bật R2 (bạn làm trên web)

1. Vào https://dash.cloudflare.com, chọn **R2 Object Storage**.
2. Bấm **Purchase R2 Plan / Enable R2** và thêm phương thức thanh toán nếu được hỏi. Dùng trong hạn mức miễn phí thì không bị tính tiền.

### 2. Tạo bucket, secret và deploy (lệnh)

Trong PowerShell, dùng `npx.cmd` thay `npx`:

```powershell
cd "C:\Users\BSS GROUP\Theme_Check"
npx.cmd wrangler@3 login                                   # nếu chưa đăng nhập
npx.cmd wrangler@3 r2 bucket create theme-check-data
node src/cli.js publish --dashboard-only
npx.cmd wrangler@3 pages deploy site --project-name theme-check --branch main
```

Hai secret `INGEST_TOKEN` (cho máy chạy check) và `READ_KEY` (mã truy cập của team) đã được tạo trước đó trên project này. Nếu cần tạo lại: `npx.cmd wrangler@3 pages secret put READ_KEY --project-name theme-check`.

Kiểm tra liên kết với R2: dash.cloudflare.com > Workers & Pages > theme-check > Settings > Bindings. Phải có R2 bucket, tên biến `STORE`, bucket `theme-check-data`.

### 3. Máy chạy check

- Biến môi trường Windows `THEME_CHECK_TOKEN` (cùng giá trị `INGEST_TOKEN`) đã đặt sẵn. Terminal mới mở sau đó mới thấy nó.
- Trong `config/config.local.json` có `"cloudflare": { "url": "https://theme-check.pages.dev" }`.
- Mã truy cập của team nằm trong `.secrets/team-access-code.txt` (file bị git bỏ qua). Gửi mã cho người trong team qua kênh riêng.

### 4. Thử

```powershell
node src/cli.js sync --all
```

Kết quả mong đợi: `Monitor updated: dashboard data, N run(s), M file(s).` Mở https://theme-check.pages.dev, nhập mã, thấy dashboard.

## Dùng hằng ngày

- Một lần chạy mới tự đẩy tiến độ (khoảng 30 giây một lần) và đẩy kết quả cùng ảnh khi xong.
- Đẩy tay: `node src/cli.js sync --all` (hoặc `--run <mã>`).
- Một lần chạy đã bắt đầu mà không có cấu hình đẩy: `node src/cli.js watch`.
- Đổi mã truy cập: `npx.cmd wrangler@3 pages secret put READ_KEY --project-name theme-check`, rồi nói với team mã mới. Cookie cũ tự mất hiệu lực.

## Mức bảo vệ

- Không có mã thì dữ liệu, trang báo cáo và ảnh đều trả 401. Cổng nhận dữ liệu từ máy chạy cũng từ chối khi thiếu `INGEST_TOKEN`. Cổng chỉ nhận file png, html, json (không nhận video).
- Mã truy cập là mật khẩu dùng chung, không phải đăng nhập theo từng người. Khi có người rời team, đổi mã.
- Nhập sai mã bị chậm 0,8 giây mỗi lần. Hãy dùng mã dài, không đặt mã dễ đoán.
- Nếu muốn đăng nhập bằng email của từng người, bật **Cloudflare Access** phía trước (Zero Trust, gói Free cho tới 50 người, có thể yêu cầu thẻ). Khi đó đặt thêm `CF_ACCESS_CLIENT_ID/SECRET` cho máy chạy.

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân |
|---|---|
| `Cannot reach the monitor: ... HTTP 401` | `THEME_CHECK_TOKEN` khác `INGEST_TOKEN`, hoặc terminal chưa nạp biến môi trường (mở terminal mới). |
| `HTTP 500` và `STORE ... missing` | Chưa gắn R2 bucket với tên biến `STORE`. |
| `THEME_CHECK_TOKEN is not set` | Tiến trình chạy trong cửa sổ mở trước khi đặt biến. Mở terminal mới. |
| Dashboard hỏi mã nhiều lần | Mã sai, hoặc trình duyệt chặn cookie của trang. |
| Tab Live trống nhưng máy đang chạy | Lần chạy đó không có cấu hình đẩy. Chạy `node src/cli.js watch`. |
| Tab Live báo STALLED | Hơn 10 phút không có cập nhật từ máy chạy: máy tắt, mất mạng, hoặc tiến trình chết. |
| Ảnh không hiện trên Cloudflare | Chạy `node src/cli.js sync --run <mã>` để đẩy ảnh của lần chạy đó. |

## Chưa làm

- Cảnh báo chủ động (email hoặc điện thoại) khi lần chạy bị dừng hay không có lần chạy nào.
