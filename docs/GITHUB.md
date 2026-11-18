# Cài đặt GitHub cho Theme_Check

Repo: https://github.com/Flintverse/Theme_Check (hiện **public**).

## Có sẵn

- Code, tài liệu, checklist, danh sách theme (staging 58, prod 45), 46 test tự động.
- `.github/workflows/ci.yml`: mỗi lần push hoặc mở pull request, GitHub chạy `npm test` trên Ubuntu (dùng Google Chrome có sẵn trên máy chủ GitHub). Không cần cấu hình gì thêm.
- `.github/workflows/deploy-dashboard.yml`: khi push lên `main` có sửa giao diện hoặc Functions (`ui/`, `functions/`, `cf/`, `wrangler.toml`), GitHub tự deploy lên Cloudflare Pages. Workflow này cần **hai secret** (làm một lần, bên dưới). Có thể chạy tay ở tab Actions bằng nút "Run workflow".

Dữ liệu chạy, ảnh, kết quả **không** đi qua GitHub: máy chạy check đẩy thẳng lên Cloudflare. GitHub chỉ chứa code.

## Việc bạn cần làm

### A. Tạo API token của Cloudflare cho GitHub

1. Đăng nhập https://dash.cloudflare.com bằng `dungnn@bsscommerce.com` > biểu tượng tài khoản (góc phải trên) > **My Profile** > **API Tokens** > **Create Token**.
2. Chọn **Create Custom Token**. Permissions: **Account** > **Cloudflare Pages** > **Edit**. Account Resources: chọn đúng tài khoản `dungnn@bsscommerce.com` (đây là tài khoản chứa project `bss-theme-check`).
3. Tạo xong, copy token (chỉ hiện một lần).

### B. Thêm hai secret vào GitHub

Repo > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**:

| Tên | Giá trị |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token vừa tạo |
| `CLOUDFLARE_ACCOUNT_ID` | `929260e1f561ff749ec1a5ceacd62255` |

### C. Nên bật

- **Settings > Branches > Add rule** cho `main`: yêu cầu workflow `tests` phải pass trước khi gộp pull request. Không bắt buộc, nhưng giúp không đẩy code hỏng lên nhánh chính.
- **Settings > Collaborators**: chỉ mời những người cần sửa code.

## Lưu ý an toàn (repo public)

- Không commit: `config/config.local.json`, `.secrets/`, `.profile-*/`, `history/`, `site/`. Tất cả đã nằm trong `.gitignore`.
- Mật khẩu store, token, mã truy cập không bao giờ được ghi vào file trong repo hay vào Issue/PR.
- Nếu bạn muốn repo **private**: Settings > General > Danger Zone > Change visibility. Các workflow vẫn chạy (gói free của GitHub có số phút Actions giới hạn mỗi tháng cho repo private, xem trang giá hiện tại).
